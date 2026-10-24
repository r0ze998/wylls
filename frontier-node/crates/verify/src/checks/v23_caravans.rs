//! V23 (S1 stage 1b, `docs/frontier/stage1b/S1-1B-CONTRACT.md` §4.1),
//! listed as `V23:caravans`: every landed vault and caravan instruction
//! re-judged from the states before its transaction and the states it
//! left, through the shared caravan kernel
//! (`permutation_rules::frontier::caravan`):
//!
//! - **BuildVault:** the tile (passable; not a site, the keep or a present
//!   camp), the counter below `MAX_VAULTS` and moved by one, the Vault as
//!   written (place, owner, faction, generation 1, cap, empty stores).
//! - **SendCaravan:** the sequence, the wallet rule (a send to another
//!   player is signed by the wallet), the walk and the schedule from the
//!   path Provinces before it, every run's slot written, the Caravan as
//!   written, a vault source debited by the cargo exactly, the counter.
//! - **SettleCaravan:** after the arrival, delivered exactly when the
//!   destination stands at the named generation, a vault credited by the
//!   cargo up to its cap, the Caravan closed.
//! - **RaidCaravan / DefaultRaid** (decision J2): an open raid of the
//!   caravan in the raid Province, the window (the raider's
//!   `RAID_DECIDE_BELLS`, the default after it). A burn: the cargo gone, the
//!   slot settled (a default burn while the raiding holding stands only
//!   `RAID_BURN_AFTER_BELLS` after the window). A take: the caravan the
//!   raider's with its cargo, its new route from the raid tile recomputed
//!   and written, no slot of its old route left.
//! - **Tower wear (1d):** a send's and a take's cargo is the cargo worn by
//!   the towers standing on the route before it (`tower::caravan_secs_in_range`;
//!   `TowerWearMismatch`).
//! - **RaidDomestic** (1e, decision K4): the caravan moving and of the
//!   raider's faction (not the raider's own), its slot on a tile at the
//!   named bell (resolved, within `RAID_DECIDE_BELLS`, not raided there
//!   before), the raider's roster host on that tile since that bell, no
//!   host of the owner's holdings there; the slot opened with the bell's
//!   offset, `RAID_POS_DOMESTIC` and the host, nothing else changed.
//! - **SeizeVault:** the captor's roster host on the vault's tile, no host
//!   of the owner's holdings there, the new owner and generation, the
//!   counters.
//! - **CloseVault:** the owner's, empty, closed.
//!
//! A Holding the vault and caravan instructions write is V7's: BuildVault
//! and a holding source are owner touches that pay, a delivery a settle
//! and a credit (`crate::holding::{touched_paid, credited}`).
//!
//! Codes: `CaravanMismatch`, `VaultMismatch`. Tamper classes T49–T51
//! (`crate::tamper`).

use frontier_abi::layout::province::{entry as EN, province as PV};
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::caravan_slot as CS;
use frontier_abi::v2::layout::s1::{caravan as CV, place as PL, vault as VA};
use frontier_abi::v2::log::raid_choice;
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::frontier::caravan::{
    self as kc, caravan_id, CaravanSlot, Land, MAX_CARAVAN_SLOTS, MAX_VAULTS,
    RAID_BURN_AFTER_BELLS, RAID_DECIDE_BELLS, RAID_SETTLED, VAULT_CAP,
};
use permutation_rules::frontier::geometry::ProvinceCoord;

use super::Ctx;
use crate::codes::{CARAVAN_MISMATCH, VAULT_MISMATCH};
use crate::world::{le, Key, Tx};

const V: &str = "V23";
const RES: usize = 8;

fn u8_at(d: &[u8], o: usize) -> Result<u8, String> {
    d.get(o)
        .copied()
        .ok_or_else(|| format!("short account at {o}"))
}
fn u32_at(d: &[u8], o: usize) -> Result<u32, String> {
    Ok(le(d
        .get(o..o + 4)
        .ok_or_else(|| format!("short account at {o}"))?)
        as u32)
}
fn u64_at(d: &[u8], o: usize) -> Result<u64, String> {
    Ok(le(d
        .get(o..o + 8)
        .ok_or_else(|| format!("short account at {o}"))?))
}
fn i64_at(d: &[u8], o: usize) -> Result<i64, String> {
    u64_at(d, o).map(|v| v as i64)
}
fn i16_at(d: &[u8], o: usize) -> Result<i16, String> {
    Ok(le(d
        .get(o..o + 2)
        .ok_or_else(|| format!("short account at {o}"))?) as u16
        as i16)
}
fn key_at(d: &[u8], o: usize) -> Result<Key, String> {
    d.get(o..o + 32)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("short account at {o}"))
}

/// The account states one judgement reads: `before(k)` the state the last
/// transaction before left (`None`: absent or unknown), `after(k)` the
/// state this transaction left (`None`: closed or absent).
pub trait States {
    fn before(&self, k: &Key) -> Option<Vec<u8>>;
    fn after(&self, k: &Key) -> Option<Vec<u8>>;
}

/// The time and bell of a judged transaction.
#[derive(Clone, Copy, Debug)]
pub struct At {
    pub now: i64,
    pub bell: u32,
    pub genesis_ts: i64,
}

/// One finding of a judgement: the code and what is wrong.
pub type Wrong = (&'static str, String);

fn vault_wrong(s: impl Into<String>) -> Wrong {
    (VAULT_MISMATCH, s.into())
}
fn caravan_wrong(s: impl Into<String>) -> Wrong {
    (CARAVAN_MISMATCH, s.into())
}

// ------------------------------------------------------------ places

/// A place as stored (`layout::s1::place`) or resolved from its account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub kind: u8,
    pub p: i16,
    pub q: i16,
    pub at: u8,
    pub gen: u8,
    pub tile: u8,
}

impl Place {
    fn stored(d: &[u8], off: usize) -> Result<Place, String> {
        Ok(Place {
            kind: u8_at(d, off + PL::KIND)?,
            p: i16_at(d, off + PL::P)?,
            q: i16_at(d, off + PL::Q)?,
            at: u8_at(d, off + PL::SITE_OR_TILE)?,
            gen: u8_at(d, off + PL::GEN)?,
            tile: u8_at(d, off + PL::TILE)?,
        })
    }
    fn coord(&self) -> ProvinceCoord {
        ProvinceCoord::new(self.p as i32, self.q as i32)
    }
}

/// The live place an account is (a Holding in state 1–2 or a live Vault)
/// and its owner Citizen; `None` when absent or not live.
pub fn live_place(d: &[u8]) -> Option<(Place, Key)> {
    if d.len() == H2::SIZE && d[..8] == H2::MAGIC {
        let st = d[H2::STATE];
        if st != H2::STATE_PROVISIONAL && st != H2::STATE_FINAL {
            return None;
        }
        return Some((
            Place {
                kind: PL::KIND_HOLDING,
                p: i16_at(d, H2::P).ok()?,
                q: i16_at(d, H2::Q).ok()?,
                at: d[H2::SITE],
                gen: d[H2::GEN],
                tile: d[H2::TILE],
            },
            key_at(d, H2::OWNER_CITIZEN).ok()?,
        ));
    }
    if d.len() == VA::SIZE && d[..8] == VA::MAGIC {
        if d[VA::STATE] != VA::STATE_LIVE {
            return None;
        }
        return Some((
            Place {
                kind: PL::KIND_VAULT,
                p: i16_at(d, VA::P).ok()?,
                q: i16_at(d, VA::Q).ok()?,
                at: d[VA::TILE],
                gen: d[VA::GEN],
                tile: d[VA::TILE],
            },
            key_at(d, VA::OWNER_CITIZEN).ok()?,
        ));
    }
    None
}

fn land_of(pd: &[u8]) -> Result<Land, String> {
    Ok(Land {
        at: ProvinceCoord::new(i16_at(pd, PV::P)? as i32, i16_at(pd, PV::Q)? as i32),
        passable: u64_at(pd, PV::PASSABLE_MASK)?,
        rough: u64_at(pd, PV::ROUGH_MASK)?,
        road: u64_at(pd, PV::ROAD_MASK)?,
    })
}

fn slots_of(pd: &[u8]) -> Result<Vec<CaravanSlot>, String> {
    (0..MAX_CARAVAN_SLOTS)
        .map(|i| {
            pd.get(CS::at(i)..CS::at(i) + CS::SIZE)
                .and_then(CaravanSlot::decode)
                .ok_or_else(|| "a caravan slot does not decode".to_string())
        })
        .collect()
}

fn cargo_of(cd: &[u8]) -> Result<[i64; RES], String> {
    let mut c = [0i64; RES];
    for (r, v) in c.iter_mut().enumerate() {
        *v = i64_at(cd, CV::cargo(r))?;
    }
    Ok(c)
}

fn vault_stores(vd: &[u8]) -> Result<[i64; RES], String> {
    let mut c = [0i64; RES];
    for (r, v) in c.iter_mut().enumerate() {
        *v = i64_at(vd, VA::store(r))?;
    }
    Ok(c)
}

// ------------------------------------------------------------ BuildVault

/// BuildVault (accounts: 3 citizen, 6 province, 7 vault).
pub fn judge_build_vault(ix: &crate::world::Ix, s: &dyn States, at: At) -> Result<(), Wrong> {
    let x = ix2::BuildVault::decode(&ix.data).map_err(|_| vault_wrong("does not decode"))?;
    let (Some(citizen), Some(province), Some(vault)) = (ix.key(3), ix.key(6), ix.key(7)) else {
        return Err(vault_wrong("the accounts are missing"));
    };
    let pd = s
        .before(&province)
        .ok_or_else(|| vault_wrong("no Province before"))?;
    let cb = s
        .before(&citizen)
        .ok_or_else(|| vault_wrong("no Citizen before"))?;
    let ca = s
        .after(&citizen)
        .ok_or_else(|| vault_wrong("no Citizen after"))?;
    let tile = x.tile;
    let land = land_of(&pd).map_err(vault_wrong)?;
    let n = (pd[PV::SITE_COUNT] as usize).min(PV::SITES_N);
    let site_tile = pd[PV::SITES..PV::SITES + n].contains(&tile);
    let keep = frontier_abi::conquest_model::read_keep(&pd)
        .map_err(|e| vault_wrong(format!("keep: {e:?}")))?
        .map(|k| k.tile);
    let camp = {
        use frontier_abi::layout::province::camp as CP;
        pd[PV::CAMP + CP::STATE] == CP::STATE_PRESENT && pd[PV::CAMP + CP::TILE] == tile
    };
    if tile as usize >= 61
        || land.passable & (1u64 << tile) == 0
        || site_tile
        || keep == Some(tile)
        || camp
    {
        return Err(vault_wrong(format!(
            "a vault on tile {tile}, which the rules refuse"
        )));
    }
    let (vb, va) = (cb[C2::VAULTS], ca[C2::VAULTS]);
    if vb >= MAX_VAULTS || va != vb + 1 {
        return Err(vault_wrong(format!("the vault counter went {vb} → {va}")));
    }
    let vd = s
        .after(&vault)
        .ok_or_else(|| vault_wrong("no Vault after"))?;
    let want = |ok: bool, what: &str| -> Result<(), Wrong> {
        if ok {
            Ok(())
        } else {
            Err(vault_wrong(format!("the Vault's {what} is not the rules'")))
        }
    };
    want(vd.len() == VA::SIZE && vd[..8] == VA::MAGIC, "account")?;
    want(vd[VA::STATE] == VA::STATE_LIVE && vd[VA::GEN] == 1, "state")?;
    want(
        i16_at(&vd, VA::P).ok() == Some(land.at.p as i16)
            && i16_at(&vd, VA::Q).ok() == Some(land.at.q as i16)
            && vd[VA::TILE] == tile,
        "place",
    )?;
    want(
        key_at(&vd, VA::OWNER_CITIZEN).ok() == Some(citizen),
        "owner",
    )?;
    want(vd[VA::FACTION] == cb[C2::FACTION], "faction")?;
    want(
        u64_at(&vd, VA::OWNER_TAG).ok() == u64_at(&cb, C2::CITIZEN_TAG).ok(),
        "owner tag",
    )?;
    want(i64_at(&vd, VA::CAP).ok() == Some(VAULT_CAP), "cap")?;
    want(vault_stores(&vd).ok() == Some([0; RES]), "stores")?;
    want(i64_at(&vd, VA::BUILT_TS).ok() == Some(at.now), "build time")?;
    Ok(())
}

// ------------------------------------------------------------ SendCaravan

/// What a walk and its schedule must leave: the arrival, the last slot
/// bell, the slots, per Province key, and the tower wear (1d: the seconds
/// in the hostile coverage of the towers standing before the instruction).
struct Routed {
    arrive: i64,
    last_bell: u32,
    slots: Vec<(Key, CaravanSlot)>,
    worn: u16,
}

/// `cargo` worn by `bps` (`tower::wear_i64` each).
fn worn_cargo(cargo: &[i64; RES], bps: u16) -> [i64; RES] {
    cargo.map(|c| permutation_rules::frontier::structure::wear_i64(c, bps))
}

#[allow(clippy::too_many_arguments)]
fn route(
    s: &dyn States,
    provinces: &[Key],
    origin: (ProvinceCoord, u8),
    dst: (ProvinceCoord, u8),
    steps: u8,
    path: &[u8; 12],
    faction: u8,
    who: &super::v24_structures::Walker,
    id: u64,
    at: At,
) -> Result<Routed, Wrong> {
    if steps == 0 {
        return if origin == dst {
            Ok(Routed {
                arrive: at.now,
                last_bell: 0,
                slots: vec![],
                worn: 0,
            })
        } else {
            Err(caravan_wrong("a walk of no step away from its destination"))
        };
    }
    let mut lands = vec![];
    let mut watches = vec![];
    for k in provinces {
        let pd = s
            .before(k)
            .ok_or_else(|| caravan_wrong("no path Province before"))?;
        lands.push(land_of(&pd).map_err(caravan_wrong)?);
        watches.push(who.watch(&pd));
    }
    let bps = permutation_rules::frontier::doctrine::of_faction_v3(faction)
        .ok_or_else(|| caravan_wrong(format!("faction {faction}")))?
        .caravan_time_bps;
    let walked = kc::walk(origin, path, steps, &lands, bps)
        .map_err(|e| caravan_wrong(format!("the walk is refused: {e:?}")))?;
    let last = walked
        .last()
        .ok_or_else(|| caravan_wrong("an empty walk"))?;
    if (last.province, last.tile) != dst {
        return Err(caravan_wrong("the walk does not end on the destination"));
    }
    let runs = kc::schedule(at.genesis_ts, at.now, origin, &walked)
        .map_err(|e| caravan_wrong(format!("the schedule is refused: {e:?}")))?;
    let mut slots = vec![];
    let mut last_bell = 0u32;
    for run in &runs {
        let i = lands
            .iter()
            .position(|l| l.at == run.province)
            .ok_or_else(|| caravan_wrong("a run outside the path"))?;
        let slot = CaravanSlot::of_run(id, faction, run)
            .ok_or_else(|| caravan_wrong("a run the slot cannot hold"))?;
        last_bell = last_bell.max(run.first_bell + run.tiles.len() as u32 - 1);
        slots.push((provinces[i], slot));
    }
    let met = permutation_rules::frontier::structure::caravan_watch(&walked, |pc| {
        lands
            .iter()
            .zip(&watches)
            .find(|(l, _)| l.at == pc)
            .map_or(Default::default(), |(_, w)| *w)
    });
    let worn = match met {
        permutation_rules::frontier::structure::Walked::Secs(secs) => {
            permutation_rules::frontier::structure::wear_bps(secs)
        }
        permutation_rules::frontier::structure::Walked::Blocked => {
            return Err((
                crate::codes::STRUCTURE_MISMATCH,
                "a caravan walked through a palisade that stops it".into(),
            ))
        }
    };
    Ok(Routed {
        arrive: at.now + kc::travel_secs(&walked) as i64,
        last_bell,
        slots,
        worn,
    })
}

/// The Caravan a send leaves, against the rules'.
#[allow(clippy::too_many_arguments)]
fn check_caravan(
    cd: &[u8],
    owner: &Key,
    seq: u32,
    faction: u8,
    src: &Place,
    dst: &Place,
    cargo: &[i64; RES],
    fee: u64,
    r: &Routed,
    at: At,
) -> Result<(), Wrong> {
    let want = |ok: bool, what: &str| -> Result<(), Wrong> {
        if ok {
            Ok(())
        } else {
            Err(caravan_wrong(format!(
                "the Caravan's {what} is not the rules'"
            )))
        }
    };
    want(cd.len() == CV::SIZE && cd[..8] == CV::MAGIC, "account")?;
    want(key_at(cd, CV::OWNER_CITIZEN).ok() == Some(*owner), "owner")?;
    want(u32_at(cd, CV::SEQ).ok() == Some(seq), "sequence")?;
    want(cd[CV::FACTION] == faction, "faction")?;
    want(cd[CV::STATE] == CV::STATE_MOVING, "state")?;
    want(Place::stored(cd, CV::SRC).ok() == Some(*src), "origin")?;
    let d = Place::stored(cd, CV::DST).map_err(caravan_wrong)?;
    want(
        (d.kind, d.p, d.q, d.at, d.gen, d.tile)
            == (dst.kind, dst.p, dst.q, dst.at, dst.gen, dst.tile),
        "destination",
    )?;
    if cargo_of(cd).ok() != Some(worn_cargo(cargo, r.worn)) {
        return Err((
            crate::codes::TOWER_WEAR_MISMATCH,
            format!(
                "the Caravan's cargo is not the sent cargo worn by {} bps",
                r.worn
            ),
        ));
    }
    want(u64_at(cd, CV::FEE).ok() == Some(fee), "fee")?;
    want(i64_at(cd, CV::DEPART_TS).ok() == Some(at.now), "departure")?;
    want(i64_at(cd, CV::ARRIVE_TS).ok() == Some(r.arrive), "arrival")?;
    want(
        u32_at(cd, CV::LAST_BELL).ok() == Some(r.last_bell),
        "last slot bell",
    )?;
    Ok(())
}

fn check_slots(s: &dyn States, r: &Routed) -> Result<(), Wrong> {
    for (k, want) in &r.slots {
        let pd = s
            .after(k)
            .ok_or_else(|| caravan_wrong("no path Province after"))?;
        let got = slots_of(&pd).map_err(caravan_wrong)?;
        if !got.contains(want) {
            return Err(caravan_wrong(format!(
                "the slot of bells {}+{} is not written in its Province",
                want.first_bell, want.n
            )));
        }
    }
    Ok(())
}

/// SendCaravan (accounts: 0 actor, 3 citizen, 4 src, 5 dst, 6 caravan, 8..
/// path Provinces).
pub fn judge_send_caravan(ix: &crate::world::Ix, s: &dyn States, at: At) -> Result<(), Wrong> {
    let x = ix2::SendCaravan::decode(&ix.data).map_err(|_| caravan_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 9 {
        return Err(caravan_wrong("the accounts are missing"));
    }
    let send = SendIx {
        actor: keys[0],
        season: keys[2],
        citizen: keys[3],
        src: keys[4],
        dst: keys[5],
        caravan: keys[6],
        provinces: keys[8..].to_vec(),
        seq: x.seq,
        dst_named: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
        steps: x.steps,
        path: x.path,
        fee: x.fee,
    };
    let cargo = ix2::cargo_milli(&x.cargo).ok_or_else(|| caravan_wrong("cargo"))?;
    judge_send(s, at, &send, &cargo, SendBy::Owner)
}

/// A send's accounts and order (SendCaravan, or S2's WithdrawShares).
pub struct SendIx {
    pub actor: Key,
    pub season: Key,
    pub citizen: Key,
    pub src: Key,
    pub dst: Key,
    pub caravan: Key,
    pub provinces: Vec<Key>,
    pub seq: u32,
    pub dst_named: (u8, i16, i16, u8, u8),
    pub steps: u8,
    pub path: [u8; 12],
    pub fee: u64,
}

/// Whether a vault's bytes are shared (S2 2b, `VA::SHARES_ON`).
pub fn vault_shared(d: &[u8]) -> bool {
    d.len() == VA::SIZE && d[..8] == VA::MAGIC && d[VA::SHARES_ON] != 0
}

/// Who sends (the program's `SendBy`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendBy {
    /// The owner: never out of a shared vault, never today's receipt
    /// reservation (2c).
    Owner,
    /// A share holder out of a shared vault (2b; V26 judges the shares).
    Shares,
    /// A receipt holder (2c; V26 judges the grant and the period).
    Receipt,
}

/// A vault's receipts period (2c).
pub fn period_of(d: &[u8]) -> Result<permutation_rules::frontier::ticket::Period, String> {
    let mut p = permutation_rules::frontier::ticket::Period {
        claim_day: u32_at(d, VA::CLAIM_DAY)?,
        res_day: u32_at(d, VA::RES_DAY)?,
        ..Default::default()
    };
    for r in 0..RES {
        p.claims[r] = u64_at(d, VA::claim(r))?;
        p.res[r] = u64_at(d, VA::res(r))?;
        p.ratio[r] = u32_at(d, VA::ratio(r))?;
    }
    Ok(p)
}

/// A vault's period rolled at `bell`'s day as the program does before the
/// stock changes (2c, `ticket::Period::roll`).
pub fn rolled(d: &[u8], bell: u32) -> Result<permutation_rules::frontier::ticket::Period, String> {
    let mut p = period_of(d)?;
    if p.active() {
        p.roll(
            bell / permutation_rules::frontier::travel::BELLS_PER_DAY,
            &vault_stores(d)?,
        );
    }
    Ok(p)
}

/// A caravan of `cargo` out of `x.src` (see [`SendBy`]).
pub fn judge_send(
    s: &dyn States,
    at: At,
    x: &SendIx,
    cargo: &[i64; RES],
    by: SendBy,
) -> Result<(), Wrong> {
    let (actor, citizen, src, dst, caravan) = (x.actor, x.citizen, x.src, x.dst, x.caravan);
    let provinces = &x.provinces[..];
    let cb = s
        .before(&citizen)
        .ok_or_else(|| caravan_wrong("no Citizen before"))?;
    let ca = s
        .after(&citizen)
        .ok_or_else(|| caravan_wrong("no Citizen after"))?;
    let seq = u32_at(&cb, C2::CARAVANS).map_err(caravan_wrong)?;
    if x.seq != seq || u32_at(&ca, C2::CARAVANS).ok() != Some(seq + 1) {
        return Err(caravan_wrong("the sequence is not the Citizen's"));
    }
    let sb = s
        .before(&src)
        .ok_or_else(|| caravan_wrong("no source before"))?;
    let (sp, sown) = live_place(&sb).ok_or_else(|| caravan_wrong("the source is not live"))?;
    if by == SendBy::Shares && !vault_shared(&sb) {
        return Err(caravan_wrong("a withdrawal from an unshared vault"));
    }
    if by == SendBy::Receipt && (sp.kind != PL::KIND_VAULT || vault_shared(&sb)) {
        return Err(caravan_wrong(
            "a receipt withdrawal not from an unshared vault",
        ));
    }
    if by == SendBy::Owner {
        if sown != citizen {
            return Err(caravan_wrong("the source is not the sender's"));
        }
        if vault_shared(&sb) {
            return Err(vault_wrong("a plain send out of a shared vault"));
        }
    }
    let db = s
        .before(&dst)
        .ok_or_else(|| caravan_wrong("no destination before"))?;
    let (dp, down) = live_place(&db).ok_or_else(|| caravan_wrong("the destination is not live"))?;
    if (dp.kind, dp.p, dp.q, dp.at, dp.gen) != x.dst_named {
        return Err(caravan_wrong("the destination is not the one named"));
    }
    // Plan §1-11: a send to another player is signed by the wallet.
    if down != citizen && key_at(&cb, C2::WALLET).ok() != Some(actor) {
        return Err(caravan_wrong("a send to another player without the wallet"));
    }
    let faction = cb[C2::FACTION];
    let tag = u64_at(&cb, C2::CITIZEN_TAG).map_err(caravan_wrong)?;
    let r = route(
        s,
        provinces,
        (sp.coord(), sp.tile),
        (dp.coord(), dp.tile),
        x.steps,
        &x.path,
        faction,
        &super::v24_structures::Walker::of(s, &x.season, &citizen, faction),
        caravan_id(tag, seq),
        at,
    )?;
    check_slots(s, &r)?;
    let cd = s
        .after(&caravan)
        .ok_or_else(|| caravan_wrong("no Caravan after"))?;
    check_caravan(&cd, &citizen, seq, faction, &sp, &dp, cargo, x.fee, &r, at)?;
    if sp.kind == PL::KIND_VAULT {
        let va = s
            .after(&src)
            .ok_or_else(|| caravan_wrong("no source after"))?;
        let (b, a) = (
            vault_stores(&sb).map_err(caravan_wrong)?,
            vault_stores(&va).map_err(caravan_wrong)?,
        );
        if (0..RES).any(|i| a[i] != b[i] - cargo[i]) {
            return Err(vault_wrong("the source vault is not debited by the cargo"));
        }
        // 2c: every send rolls the period first; the owner's leaves today's
        // reservation (a receipt withdrawal's period is V26's).
        if by != SendBy::Receipt {
            let p = rolled(&sb, at.bell).map_err(caravan_wrong)?;
            let today = at.bell / permutation_rules::frontier::travel::BELLS_PER_DAY;
            if by == SendBy::Owner && (0..RES).any(|r| cargo[r] > p.available(today, r, b[r])) {
                return Err(vault_wrong(
                    "a send took goods reserved for today's receipts",
                ));
            }
            if period_of(&va).map_err(caravan_wrong)? != p {
                return Err(vault_wrong("the vault's receipts period is not the roll's"));
            }
        }
        let sent = u32_at(&sb, VA::SENT).map_err(caravan_wrong)?;
        if u32_at(&va, VA::SENT).ok() != Some(sent.saturating_add(1)) {
            return Err(vault_wrong("the vault's sends are not counted"));
        }
        // Nothing else of the vault changes (its chain header, stores, sends
        // and period aside).
        let touched = |o: usize| {
            o < 64
                || (VA::STORES..VA::STORES + 64).contains(&o)
                || (VA::SENT..VA::SENT + 4).contains(&o)
                || (VA::CLAIM_DAY..VA::RSV).contains(&o)
        };
        if sb.len() != va.len() || (0..sb.len()).any(|o| !touched(o) && sb[o] != va[o]) {
            return Err(vault_wrong("a send changed more of the vault than its goods"));
        }
    }
    Ok(())
}

/// WithdrawShares' caravan (S2 2b; accounts: 0 actor, 2 season, 3 citizen,
/// 4 lot, 5 issue, 6 src, 7 dst, 8 caravan, 10.. path Provinces): a send of
/// the basket the vault paid (V26 judges that it is the basket).
pub fn judge_withdraw_caravan(ix: &crate::world::Ix, s: &dyn States, at: At) -> Result<(), Wrong> {
    let x = ix2::WithdrawShares::decode(&ix.data).map_err(|_| caravan_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 11 {
        return Err(caravan_wrong("the accounts are missing"));
    }
    let send = SendIx {
        actor: keys[0],
        season: keys[2],
        citizen: keys[3],
        src: keys[6],
        dst: keys[7],
        caravan: keys[8],
        provinces: keys[10..].to_vec(),
        seq: x.seq,
        dst_named: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
        steps: x.steps,
        path: x.path,
        fee: x.fee,
    };
    let (b, a) = (
        vault_stores(&s.before(&send.src).unwrap_or_default()).map_err(caravan_wrong)?,
        vault_stores(&s.after(&send.src).unwrap_or_default()).map_err(caravan_wrong)?,
    );
    let mut paid = [0i64; RES];
    for r in 0..RES {
        paid[r] = b[r] - a[r];
    }
    judge_send(s, at, &send, &paid, SendBy::Shares)
}

/// WithdrawReceipt's caravan (S2 2c; WithdrawShares' accounts): a send of
/// what the vault paid (V26 judges that it is the grant).
pub fn judge_receipt_caravan(ix: &crate::world::Ix, s: &dyn States, at: At) -> Result<(), Wrong> {
    let x = ix2::WithdrawReceipt::decode(&ix.data).map_err(|_| caravan_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 11 {
        return Err(caravan_wrong("the accounts are missing"));
    }
    let send = SendIx {
        actor: keys[0],
        season: keys[2],
        citizen: keys[3],
        src: keys[6],
        dst: keys[7],
        caravan: keys[8],
        provinces: keys[10..].to_vec(),
        seq: x.seq,
        dst_named: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
        steps: x.steps,
        path: x.path,
        fee: x.fee,
    };
    let (b, a) = (
        vault_stores(&s.before(&send.src).unwrap_or_default()).map_err(caravan_wrong)?,
        vault_stores(&s.after(&send.src).unwrap_or_default()).map_err(caravan_wrong)?,
    );
    let mut paid = [0i64; RES];
    for r in 0..RES {
        paid[r] = b[r] - a[r];
    }
    judge_send(s, at, &send, &paid, SendBy::Receipt)
}

// ------------------------------------------------------------ SettleCaravan

/// SettleCaravan (accounts: 2 caravan, 3 dst). `delivered`: the record's
/// outcome. `deposit` (S2 2b, SettleDeposit): the destination must be a
/// live shared vault; without it, it must not be one.
pub fn judge_settle_caravan(
    ix: &crate::world::Ix,
    s: &dyn States,
    at: At,
    delivered: Option<bool>,
    deposit: bool,
) -> Result<(), Wrong> {
    let (Some(caravan), Some(dst)) = (ix.key(2), ix.key(3)) else {
        return Err(caravan_wrong("the accounts are missing"));
    };
    let cb = s
        .before(&caravan)
        .ok_or_else(|| caravan_wrong("no Caravan before"))?;
    if cb.get(CV::STATE) != Some(&CV::STATE_MOVING) {
        return Err(caravan_wrong("a Caravan settled that was not moving"));
    }
    if at.now < i64_at(&cb, CV::ARRIVE_TS).map_err(caravan_wrong)? {
        return Err(caravan_wrong("settled before its arrival"));
    }
    if s.after(&caravan).is_some() {
        return Err(caravan_wrong("the Caravan is not closed"));
    }
    let named = Place::stored(&cb, CV::DST).map_err(caravan_wrong)?;
    let live = s
        .before(&dst)
        .and_then(|d| live_place(&d))
        .is_some_and(|(p, _)| p.kind == named.kind && p.gen == named.gen && p.at == named.at);
    if let Some(d) = delivered {
        if d != live {
            return Err(caravan_wrong(if live {
                "a delivery to a live destination recorded lost"
            } else {
                "a delivery to a lost destination"
            }));
        }
    }
    let shared = live && s.before(&dst).is_some_and(|d| vault_shared(&d));
    if deposit && !shared {
        return Err(vault_wrong(
            "a deposit settled into an unshared or lost vault",
        ));
    }
    if !deposit && shared {
        return Err(vault_wrong("a plain settle into a shared vault"));
    }
    let cargo = cargo_of(&cb).map_err(caravan_wrong)?;
    if live && named.kind == PL::KIND_VAULT {
        let (b, a) = (
            vault_stores(&s.before(&dst).unwrap_or_default()).map_err(caravan_wrong)?,
            vault_stores(&s.after(&dst).unwrap_or_default()).map_err(caravan_wrong)?,
        );
        let vb = s.before(&dst).unwrap_or_default();
        let cap = i64_at(&vb, VA::CAP).map_err(caravan_wrong)?;
        // 2c: the delivery rolls the period first.
        let want = rolled(&vb, at.bell).map_err(caravan_wrong)?;
        if period_of(&s.after(&dst).unwrap_or_default()).map_err(caravan_wrong)? != want {
            return Err(vault_wrong("the vault's receipts period is not the roll's"));
        }
        for r in 0..RES {
            let want = b[r].saturating_add(cargo[r]).min(cap.max(b[r]));
            if a[r] != want {
                return Err(vault_wrong(format!(
                    "the vault holds {} of resource {r} after the delivery, the rules {want}",
                    a[r]
                )));
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------ the raids

/// A raid settlement's accounts and data (RaidCaravan or DefaultRaid).
pub struct RaidIx {
    pub season: Key,
    pub caravan: Key,
    pub raider_holding: Key,
    pub raider_citizen: Key,
    /// RaidCaravan's destination account (DefaultRaid: the raider holding).
    pub dst: Key,
    /// The new walk's Provinces first (the raid's first), then the old
    /// route's others.
    pub provinces: Vec<Key>,
    pub n_path: u8,
    pub steps: u8,
    pub path: [u8; 12],
    /// RaidCaravan's named destination `(kind, p, q, at, gen)`; `None` for
    /// DefaultRaid (the raiding holding).
    pub named: Option<(u8, i16, i16, u8, u8)>,
    pub by_default: bool,
}

/// RaidCaravan and DefaultRaid (decision J2): the open raid, the window,
/// and `choice` (the CARAVAN_RAIDED record's):
/// - a burn: the cargo gone, the raid's slot settled; a default burn while
///   the raiding holding stands only `RAID_BURN_AFTER_BELLS` after the
///   window;
/// - a take: the caravan the raider's (owner, faction), its cargo kept, its
///   new route from the raid tile to the raider's place recomputed, the new
///   slots written and none of the old route's left.
pub fn judge_raid(s: &dyn States, at: At, x: &RaidIx, choice: u8) -> Result<(), Wrong> {
    let cb = s
        .before(&x.caravan)
        .ok_or_else(|| caravan_wrong("no Caravan before"))?;
    let tag = u64_at(&cb, CV::OWNER_TAG).map_err(caravan_wrong)?;
    let seq = u32_at(&cb, CV::SEQ).map_err(caravan_wrong)?;
    let id = caravan_id(tag, seq);
    let raid_province = *x
        .provinces
        .first()
        .ok_or_else(|| caravan_wrong("no raid Province"))?;
    let pb = s
        .before(&raid_province)
        .ok_or_else(|| caravan_wrong("no raid Province before"))?;
    let slot = slots_of(&pb)
        .map_err(caravan_wrong)?
        .into_iter()
        .find(|y| y.id == id)
        .filter(|y| y.raid_open())
        .ok_or_else(|| caravan_wrong("no open raid of this caravan"))?;
    let raid_bell = slot.first_bell + slot.raid_off as u32;
    let last = raid_bell + RAID_DECIDE_BELLS;
    if x.by_default && at.bell <= last {
        return Err(caravan_wrong("a default raid inside the raider's window"));
    }
    if !x.by_default && at.bell > last {
        return Err(caravan_wrong("a raid decided after the raider's window"));
    }
    let parts = frontier_abi::addr::split_host_id(slot.raider)
        .ok_or_else(|| caravan_wrong("the raider is not a host id"))?;
    let home = s
        .before(&x.raider_holding)
        .and_then(|d| live_place(&d))
        .filter(|(p, _)| {
            (p.p as i32, p.q as i32, p.at, p.gen)
                == (parts.province.p, parts.province.q, parts.site, parts.gen)
        });
    let ca = s
        .after(&x.caravan)
        .ok_or_else(|| caravan_wrong("no Caravan after"))?;
    let cargo = cargo_of(&cb).map_err(caravan_wrong)?;
    if choice == raid_choice::BURN {
        if x.by_default && home.is_some() && at.bell <= last + RAID_BURN_AFTER_BELLS {
            return Err(caravan_wrong(
                "a default burn while the raiding holding stands, before the burn delay",
            ));
        }
        if cargo_of(&ca).map_err(caravan_wrong)? != [0; RES] {
            return Err(caravan_wrong("a burn left cargo"));
        }
        let pa = s
            .after(&raid_province)
            .ok_or_else(|| caravan_wrong("no raid Province after"))?;
        if !slots_of(&pa)
            .map_err(caravan_wrong)?
            .iter()
            .any(|y| y.id == id && y.raid_off == RAID_SETTLED)
        {
            return Err(caravan_wrong("the raid's slot is not settled"));
        }
        return Ok(());
    }
    // A take: the raider and its place.
    let (home_place, owner) =
        home.ok_or_else(|| caravan_wrong("a take for a raiding holding that is gone"))?;
    if owner != x.raider_citizen {
        return Err(caravan_wrong(
            "the caravan taken by another than the raiding holding's owner",
        ));
    }
    let rc = s
        .before(&x.raider_citizen)
        .ok_or_else(|| caravan_wrong("no raider Citizen before"))?;
    let faction = rc[C2::FACTION];
    let dst = match x.named {
        None => home_place,
        Some((kind, p, q, at_, gen)) => {
            // the named place: live and the raider's
            let d = s
                .before(&x.dst)
                .and_then(|d| live_place(&d))
                .ok_or_else(|| caravan_wrong("the destination is not live"))?;
            if (d.0.kind, d.0.p, d.0.q, d.0.at, d.0.gen) != (kind, p, q, at_, gen)
                || d.1 != x.raider_citizen
            {
                return Err(caravan_wrong(
                    "the destination is not the raider's named place",
                ));
            }
            d.0
        }
    };
    let n = x.n_path as usize;
    if n == 0 || n > x.provinces.len() {
        return Err(caravan_wrong("n_path"));
    }
    let raid_tile = slot.tiles[slot.raid_off as usize];
    let raid_pc = ProvinceCoord::new(
        i16_at(&pb, PV::P).map_err(caravan_wrong)? as i32,
        i16_at(&pb, PV::Q).map_err(caravan_wrong)? as i32,
    );
    let r = route(
        s,
        &x.provinces[..n],
        (raid_pc, raid_tile),
        (dst.coord(), dst.tile),
        x.steps,
        &x.path,
        faction,
        &super::v24_structures::Walker::of(s, &x.season, &x.raider_citizen, faction),
        id,
        at,
    )?;
    check_slots(s, &r)?;
    // No slot of the old route is left (a ghost the clash would see).
    let n_old = (cb[CV::N_PROV] as usize).min(4);
    for i in 0..n_old {
        let (op, oq) = (
            i16_at(&cb, CV::province(i)).map_err(caravan_wrong)?,
            i16_at(&cb, CV::province(i) + 2).map_err(caravan_wrong)?,
        );
        for k in &x.provinces {
            let Some(pa) = s.after(k) else { continue };
            if (i16_at(&pa, PV::P).ok(), i16_at(&pa, PV::Q).ok()) != (Some(op), Some(oq)) {
                continue;
            }
            for y in slots_of(&pa).map_err(caravan_wrong)? {
                if y.id == id && !r.slots.iter().any(|(kk, w)| kk == k && *w == y) {
                    return Err(caravan_wrong(
                        "a slot of the old route is left after the take",
                    ));
                }
            }
        }
    }
    let field = Place {
        kind: frontier_abi::v2::log::log_place::KIND_FIELD,
        p: raid_pc.p as i16,
        q: raid_pc.q as i16,
        at: raid_tile,
        gen: 0,
        tile: raid_tile,
    };
    let want = |ok: bool, what: &str| -> Result<(), Wrong> {
        if ok {
            Ok(())
        } else {
            Err(caravan_wrong(format!(
                "the taken Caravan's {what} is not the rules'"
            )))
        }
    };
    want(
        key_at(&ca, CV::OWNER_CITIZEN).ok() == Some(x.raider_citizen),
        "owner",
    )?;
    want(ca[CV::FACTION] == faction, "faction")?;
    want(u64_at(&ca, CV::OWNER_TAG).ok() == Some(tag), "address tag")?;
    if cargo_of(&ca).ok() != Some(worn_cargo(&cargo, r.worn)) {
        return Err((
            crate::codes::TOWER_WEAR_MISMATCH,
            format!(
                "the taken Caravan's cargo is not its cargo worn by {} bps",
                r.worn
            ),
        ));
    }
    want(Place::stored(&ca, CV::SRC).ok() == Some(field), "origin")?;
    let d = Place::stored(&ca, CV::DST).map_err(caravan_wrong)?;
    want(
        (d.kind, d.p, d.q, d.at, d.gen, d.tile)
            == (dst.kind, dst.p, dst.q, dst.at, dst.gen, dst.tile),
        "destination",
    )?;
    want(i64_at(&ca, CV::DEPART_TS).ok() == Some(at.now), "departure")?;
    want(i64_at(&ca, CV::ARRIVE_TS).ok() == Some(r.arrive), "arrival")?;
    want(
        u32_at(&ca, CV::LAST_BELL).ok() == Some(r.last_bell),
        "last slot bell",
    )?;
    Ok(())
}

// ------------------------------------------------------------ SeizeVault, CloseVault

/// SeizeVault (accounts: 3 captor citizen, 4 vault, 5 province, 6
/// host_holding, 7 owner_citizen).
/// RaidDomestic (accounts: 3 raider citizen, 4 caravan, 5 province, 6
/// host holding, 7 owner citizen).
pub fn judge_raid_domestic(ix: &crate::world::Ix, s: &dyn States, at: At) -> Result<(), Wrong> {
    use frontier_abi::clash_model::RAID_POS_DOMESTIC;
    let x = ix2::RaidDomestic::decode(&ix.data).map_err(|_| caravan_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 8 {
        return Err(caravan_wrong("the accounts are missing"));
    }
    let (raider, caravan, province, hk, owner) = (keys[3], keys[4], keys[5], keys[6], keys[7]);
    let before = |k: &Key, what: &str| {
        s.before(k)
            .ok_or_else(|| caravan_wrong(format!("no {what} before")))
    };
    let cd = before(&caravan, "Caravan")?;
    let rd = before(&raider, "raider Citizen")?;
    let od = before(&owner, "owner Citizen")?;
    let pd = before(&province, "Province")?;
    let pa = s
        .after(&province)
        .ok_or_else(|| caravan_wrong("no Province after"))?;
    if cd[CV::STATE] != CV::STATE_MOVING
        || key_at(&cd, CV::OWNER_CITIZEN).ok() != Some(owner)
        || owner == raider
        || cd[CV::FACTION] != rd[C2::FACTION]
    {
        return Err(caravan_wrong(
            "a domestic raid on a caravan the rules refuse",
        ));
    }
    let rn = u32_at(&pd, PV::RESOLVED_NEXT).map_err(caravan_wrong)?;
    if x.bell >= rn || at.bell > x.bell + RAID_DECIDE_BELLS {
        return Err(caravan_wrong("a domestic raid outside its window"));
    }
    let id = kc::caravan_id(
        u64_at(&cd, CV::OWNER_TAG).map_err(caravan_wrong)?,
        u32_at(&cd, CV::SEQ).map_err(caravan_wrong)?,
    );
    let sb = slots_of(&pd).map_err(caravan_wrong)?;
    let i = sb
        .iter()
        .position(|x| x.id == id)
        .ok_or_else(|| caravan_wrong("a domestic raid where the caravan has no slot"))?;
    let tile = sb[i]
        .tile_at(x.bell)
        .ok_or_else(|| caravan_wrong("a domestic raid at a bell the caravan was not there"))?;
    let owner_holdings: Vec<u64> = (1..=3u8)
        .filter_map(|slot| {
            let o = C2::holding_of_slot(slot);
            let (p, q) = (i16_at(&od, o).ok()?, i16_at(&od, o + 2).ok()?);
            let (site, gen) = (*od.get(o + 4)?, *od.get(o + 5)?);
            (gen != C2::EMPTY_GEN)
                .then(|| frontier_abi::addr::host_id(p as i32, q as i32, site, gen, 0))
                .flatten()
        })
        .collect();
    let part = |id: u64| id & !0xFFFF_FFFF;
    let mut host = None;
    for e in 0..PV::ENTRIES_N {
        let o = PV::entry(e);
        let en = pd
            .get(o..o + EN::SIZE)
            .ok_or_else(|| caravan_wrong("short Province"))?;
        if en[EN::STATE] != EN::STATE_ROSTER || en[EN::TILE] != tile {
            continue;
        }
        let hid = le(&en[EN::ID..EN::ID + 8]);
        if owner_holdings.contains(&part(hid)) {
            return Err(caravan_wrong("a domestic raid past the owner's escort"));
        }
        if e == x.entry as usize && le(&en[EN::FROM_BELL..EN::FROM_BELL + 4]) as u32 <= x.bell {
            host = Some(hid);
        }
    }
    let host = host.ok_or_else(|| caravan_wrong("a domestic raid without the raider's host"))?;
    let hd = before(&hk, "host Holding")?;
    let parts = frontier_abi::addr::split_host_id(host).ok_or_else(|| caravan_wrong("host id"))?;
    if hd.get(H2::GEN) != Some(&parts.gen) || key_at(&hd, H2::OWNER_CITIZEN).ok() != Some(raider) {
        return Err(caravan_wrong("the raiding host is not the raider's"));
    }
    let mut want = sb.clone();
    want[i].raid_off = (x.bell - sb[i].first_bell) as u8;
    want[i].raid_pos = RAID_POS_DOMESTIC;
    want[i].raider = host;
    if slots_of(&pa).map_err(caravan_wrong)? != want {
        return Err(caravan_wrong("the slots are not the domestic raid's"));
    }
    Ok(())
}

pub fn judge_seize_vault(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = ix2::SeizeVault::decode(&ix.data).map_err(|_| vault_wrong("does not decode"))?;
    let keys: Vec<Key> = (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
    if keys.len() < 8 {
        return Err(vault_wrong("the accounts are missing"));
    }
    let (captor, vault, province, owner) = (keys[3], keys[4], keys[5], keys[7]);
    let vb = s
        .before(&vault)
        .ok_or_else(|| vault_wrong("no Vault before"))?;
    let (vp, vown) = live_place(&vb).ok_or_else(|| vault_wrong("the vault is not live"))?;
    if vown != owner || vown == captor {
        return Err(vault_wrong("the seizure's owner or captor is wrong"));
    }
    let pd = s
        .before(&province)
        .ok_or_else(|| vault_wrong("no Province before"))?;
    let od = s
        .before(&owner)
        .ok_or_else(|| vault_wrong("no owner Citizen before"))?;
    let rn = u32_at(&pd, PV::RESOLVED_NEXT).map_err(vault_wrong)?;
    let owner_holdings: Vec<u64> = (1..=3u8)
        .filter_map(|slot| {
            let o = C2::holding_of_slot(slot);
            let (p, q) = (i16_at(&od, o).ok()?, i16_at(&od, o + 2).ok()?);
            let (site, gen) = (*od.get(o + 4)?, *od.get(o + 5)?);
            (gen != C2::EMPTY_GEN)
                .then(|| frontier_abi::addr::host_id(p as i32, q as i32, site, gen, 0))
                .flatten()
        })
        .collect();
    let part = |id: u64| id & !0xFFFF_FFFF;
    let mut captor_host = None;
    for i in 0..PV::ENTRIES_N {
        let o = PV::entry(i);
        let e = pd
            .get(o..o + EN::SIZE)
            .ok_or_else(|| vault_wrong("short Province"))?;
        if e[EN::STATE] != EN::STATE_ROSTER || e[EN::TILE] != vp.tile {
            continue;
        }
        let id = le(&e[EN::ID..EN::ID + 8]);
        if owner_holdings.contains(&part(id)) {
            return Err(vault_wrong("seized while a host of the owner stands on it"));
        }
        if i == x.entry as usize && le(&e[EN::FROM_BELL..EN::FROM_BELL + 4]) as u32 <= rn {
            captor_host = Some(id);
        }
    }
    let host = captor_host.ok_or_else(|| vault_wrong("seized without the captor's host on it"))?;
    let hk = keys[6];
    let hd = s
        .before(&hk)
        .ok_or_else(|| vault_wrong("no host Holding before"))?;
    let parts = frontier_abi::addr::split_host_id(host).ok_or_else(|| vault_wrong("host id"))?;
    if hd.get(H2::GEN) != Some(&parts.gen) || key_at(&hd, H2::OWNER_CITIZEN).ok() != Some(captor) {
        return Err(vault_wrong("the standing host is not the captor's"));
    }
    let va = s
        .after(&vault)
        .ok_or_else(|| vault_wrong("no Vault after"))?;
    if key_at(&va, VA::OWNER_CITIZEN).ok() != Some(captor) || va[VA::GEN] != vp.gen.wrapping_add(1)
    {
        return Err(vault_wrong("the seized vault's owner or generation"));
    }
    if vault_stores(&va).ok() != vault_stores(&vb).ok() {
        return Err(vault_wrong("a seizure moved the goods"));
    }
    // S2: the shares (2b) and the receipts' period (2c) of the old
    // generation are gone.
    let share_ids = va.get(VA::SHARES_SEQ..VA::SHARES_SEQ + 12);
    if vault_shared(&va)
        || share_ids.is_none_or(|b| b.iter().any(|&x| x != 0))
        || period_of(&va).map_err(vault_wrong)? != Default::default()
    {
        return Err(vault_wrong("a seizure kept the old generation's tickets"));
    }
    let (cb, ca) = (s.before(&captor), s.after(&captor));
    let (ob, oa) = (Some(od), s.after(&owner));
    let moved = |b: Option<Vec<u8>>, a: Option<Vec<u8>>, d: i16| matches!((b, a), (Some(b), Some(a)) if a[C2::VAULTS] as i16 == b[C2::VAULTS] as i16 + d);
    if !moved(cb, ca, 1) || !moved(ob, oa, -1) {
        return Err(vault_wrong("the vault counters did not move"));
    }
    if ca_vaults_over(s, &captor) {
        return Err(vault_wrong("a captor over the vault limit"));
    }
    Ok(())
}

fn ca_vaults_over(s: &dyn States, captor: &Key) -> bool {
    s.after(captor).is_some_and(|a| a[C2::VAULTS] > MAX_VAULTS)
}

/// CloseVault (accounts: 3 citizen, 4 vault).
pub fn judge_close_vault(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let (Some(citizen), Some(vault)) = (ix.key(3), ix.key(4)) else {
        return Err(vault_wrong("the accounts are missing"));
    };
    let vb = s
        .before(&vault)
        .ok_or_else(|| vault_wrong("no Vault before"))?;
    if key_at(&vb, VA::OWNER_CITIZEN).ok() != Some(citizen) {
        return Err(vault_wrong("closed by another than its owner"));
    }
    if vault_stores(&vb).map_err(vault_wrong)? != [0; RES] {
        return Err(vault_wrong("a vault closed with goods in it"));
    }
    if s.after(&vault).is_some() {
        return Err(vault_wrong("the vault is not closed"));
    }
    Ok(())
}

// ------------------------------------------------------------ the check

pub(crate) struct TxStates<'a> {
    pub(crate) w: &'a crate::world::World,
    pub(crate) tx: &'a Tx,
    pub(crate) t: usize,
}

impl States for TxStates<'_> {
    fn before(&self, k: &Key) -> Option<Vec<u8>> {
        self.w.state_before(k, self.t).map(|d| d.to_vec())
    }
    fn after(&self, k: &Key) -> Option<Vec<u8>> {
        match self.tx.post.get(k) {
            Some(Some(a)) if !a.data.is_empty() => Some(a.data.clone()),
            Some(_) => None,
            None => self.before(k),
        }
    }
}

/// The choice the transaction's CARAVAN_RAIDED records (a DefaultRaid's
/// take or burn; the states then must follow it).
fn raided_choice(cx: &Ctx, t: usize) -> Option<u8> {
    use frontier_abi::v2::log::CqKind;
    cx.w.cq_recs
        .iter()
        .find(|r| r.tx == t && r.kind == CqKind::CARAVAN_RAIDED)
        .map(|r| r.pu("choice") as u8)
}

/// The SettleCaravan outcome the transaction's CARAVAN_SETTLED records.
fn settled_outcome(cx: &Ctx, t: usize) -> Option<bool> {
    use frontier_abi::v2::log::{caravan_outcome, CqKind};
    cx.w.cq_recs
        .iter()
        .find(|r| r.tx == t && r.kind == CqKind::CARAVAN_SETTLED)
        .map(|r| r.pu("outcome") as u8 == caravan_outcome::DELIVERED)
}

pub fn run(cx: &mut Ctx) {
    if !cx.s1 {
        return;
    }
    let w = cx.w;
    let tags = [
        V2Ix::BuildVault,
        V2Ix::SendCaravan,
        V2Ix::SettleCaravan,
        V2Ix::RaidCaravan,
        V2Ix::SeizeVault,
        V2Ix::CloseVault,
        V2Ix::DefaultRaid,
        V2Ix::RaidDomestic,
        V2Ix::WithdrawShares,
        V2Ix::SettleDeposit,
        V2Ix::WithdrawReceipt,
    ];
    let any = w.txs.iter().any(|tx| {
        tx.ok
            && tx
                .ixs
                .iter()
                .any(|i| i.tag().is_some_and(|x| tags.iter().any(|t| t.tag() == x)))
    });
    if !any {
        return;
    }
    if !w.has_post {
        cx.missing(
            V,
            "caravans",
            0,
            None,
            "no post-states: the vault and caravan instructions cannot be re-judged",
        );
        return;
    }
    let genesis_ts = cx.f.genesis_ts;
    let mut found: Vec<(usize, u32, &'static str, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate().filter(|(_, tx)| tx.ok) {
        let bell = frontier_abi::prologue::bell_at(genesis_ts, tx.time).unwrap_or(0);
        let at = At {
            now: tx.time,
            bell,
            genesis_ts,
        };
        let st = TxStates { w, tx, t };
        for ix in &tx.ixs {
            let Some(tag) = ix.tag() else { continue };
            let r = match V2Ix::from_tag(tag) {
                Some(V2Ix::BuildVault) => judge_build_vault(ix, &st, at),
                Some(V2Ix::SendCaravan) => judge_send_caravan(ix, &st, at),
                Some(V2Ix::SettleCaravan) => {
                    judge_settle_caravan(ix, &st, at, settled_outcome(cx, t), false)
                }
                // S2 2b: the delivery of a SettleDeposit (V26 judges the
                // minting) and the caravan of a WithdrawShares (V26 judges
                // the shares and the basket).
                Some(V2Ix::SettleDeposit) => {
                    judge_settle_caravan(ix, &st, at, settled_outcome(cx, t), true)
                }
                Some(V2Ix::WithdrawShares) => judge_withdraw_caravan(ix, &st, at),
                // 2c: a receipt withdrawal's caravan (V26 judges the grant).
                Some(V2Ix::WithdrawReceipt) => judge_receipt_caravan(ix, &st, at),
                Some(V2Ix::RaidCaravan) => match ix2::RaidCaravan::decode(&ix.data) {
                    Ok(x) => {
                        let keys: Vec<Key> =
                            (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
                        if keys.len() < 8 {
                            Err(caravan_wrong("a RaidCaravan without its accounts"))
                        } else {
                            let r = RaidIx {
                                season: keys[2],
                                caravan: keys[4],
                                raider_holding: keys[5],
                                raider_citizen: keys[3],
                                dst: keys[6],
                                provinces: keys[7..].to_vec(),
                                n_path: x.n_path,
                                steps: x.steps,
                                path: x.path,
                                named: Some((x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen)),
                                by_default: false,
                            };
                            judge_raid(&st, at, &r, x.choice)
                        }
                    }
                    Err(_) => Err(caravan_wrong("a RaidCaravan that does not decode")),
                },
                Some(V2Ix::DefaultRaid) => match ix2::DefaultRaid::decode(&ix.data) {
                    Ok(x) => {
                        let keys: Vec<Key> =
                            (0..ix.accounts.len()).filter_map(|i| ix.key(i)).collect();
                        if keys.len() < 7 {
                            Err(caravan_wrong("a DefaultRaid without its accounts"))
                        } else {
                            let r = RaidIx {
                                season: keys[1],
                                caravan: keys[2],
                                raider_holding: keys[3],
                                raider_citizen: keys[4],
                                dst: keys[3],
                                provinces: keys[6..].to_vec(),
                                n_path: x.n_path,
                                steps: x.steps,
                                path: x.path,
                                named: None,
                                by_default: true,
                            };
                            match raided_choice(cx, t) {
                                Some(c) => judge_raid(&st, at, &r, c),
                                None => {
                                    Err(caravan_wrong("a DefaultRaid without its CARAVAN_RAIDED"))
                                }
                            }
                        }
                    }
                    Err(_) => Err(caravan_wrong("a DefaultRaid that does not decode")),
                },
                Some(V2Ix::RaidDomestic) => judge_raid_domestic(ix, &st, at),
                Some(V2Ix::SeizeVault) => judge_seize_vault(ix, &st),
                Some(V2Ix::CloseVault) => judge_close_vault(ix, &st),
                _ => continue,
            };
            if let Err((code, detail)) = r {
                found.push((t, bell, code, detail));
            }
        }
    }
    for (t, bell, code, detail) in found {
        cx.fail(V, code, "caravans", bell, Some(t), detail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Mock {
        before: HashMap<Key, Vec<u8>>,
        after: HashMap<Key, Option<Vec<u8>>>,
    }

    impl States for Mock {
        fn before(&self, k: &Key) -> Option<Vec<u8>> {
            self.before.get(k).cloned()
        }
        fn after(&self, k: &Key) -> Option<Vec<u8>> {
            match self.after.get(k) {
                Some(v) => v.clone(),
                None => self.before(k),
            }
        }
    }

    fn k(n: u8) -> Key {
        [n; 32]
    }

    fn ix(tag: u8, data: Vec<u8>, keys: &[Key]) -> crate::world::Ix {
        let mut d = vec![tag];
        d.extend(data);
        crate::world::Ix {
            index: 0,
            data: d,
            accounts: keys.iter().map(|k| (*k, true)).collect(),
        }
    }

    fn vault_bytes(owner: Key, tile: u8, gen: u8) -> Vec<u8> {
        let mut d = vec![0u8; VA::SIZE];
        assert!(frontier_abi::v2::layout::write_header(
            &mut d,
            frontier_abi::v2::layout::AccountKind::Vault,
            1
        ));
        d[VA::TILE] = tile;
        d[VA::STATE] = VA::STATE_LIVE;
        d[VA::GEN] = gen;
        d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&owner);
        d[VA::CAP..VA::CAP + 8].copy_from_slice(&VAULT_CAP.to_le_bytes());
        d
    }

    /// A vault closed with goods, or by another, is a VaultMismatch.
    #[test]
    fn close_vault_rules() {
        let (citizen, vault) = (k(3), k(4));
        let keys = [k(0), k(1), k(2), citizen, vault, k(5)];
        let close = ix(0xB5, vec![], &keys);
        let mut m = Mock {
            before: HashMap::from([(vault, vault_bytes(citizen, 9, 1))]),
            after: HashMap::from([(vault, None)]),
        };
        assert_eq!(judge_close_vault(&close, &m), Ok(()));
        m.before.get_mut(&vault).unwrap()[VA::store(2)] = 1;
        assert_eq!(judge_close_vault(&close, &m).unwrap_err().0, VAULT_MISMATCH);
        let other = ix(0xB5, vec![], &[k(0), k(1), k(2), k(9), vault, k(5)]);
        m.before.get_mut(&vault).unwrap()[VA::store(2)] = 0;
        assert_eq!(judge_close_vault(&other, &m).unwrap_err().0, VAULT_MISMATCH);
    }

    /// A delivery to a vault credits the cargo up to the cap; twice the
    /// cargo (T50's shape) is a VaultMismatch.
    #[test]
    fn settle_to_vault_credits_the_cargo_once() {
        let (caravan, vault) = (k(2), k(3));
        let mut cb = vec![0u8; CV::SIZE];
        assert!(frontier_abi::v2::layout::write_header(
            &mut cb,
            frontier_abi::v2::layout::AccountKind::Caravan,
            1
        ));
        cb[CV::STATE] = CV::STATE_MOVING;
        cb[CV::ARRIVE_TS..CV::ARRIVE_TS + 8].copy_from_slice(&100i64.to_le_bytes());
        cb[CV::DST + PL::KIND] = PL::KIND_VAULT;
        cb[CV::DST + PL::SITE_OR_TILE] = 9;
        cb[CV::DST + PL::GEN] = 1;
        cb[CV::DST + PL::TILE] = 9;
        cb[CV::cargo(1)..CV::cargo(1) + 8].copy_from_slice(&7_000i64.to_le_bytes());
        let vb = vault_bytes(k(8), 9, 1);
        let mut va = vb.clone();
        va[VA::store(1)..VA::store(1) + 8].copy_from_slice(&7_000i64.to_le_bytes());
        let settle = ix(
            0xB2,
            vec![0; 32],
            &[k(0), k(1), caravan, vault, k(4), k(5), k(6)],
        );
        let at = At {
            now: 100,
            bell: 0,
            genesis_ts: 0,
        };
        let mut m = Mock {
            before: HashMap::from([(caravan, cb.clone()), (vault, vb.clone())]),
            after: HashMap::from([(caravan, None), (vault, Some(va.clone()))]),
        };
        assert_eq!(
            judge_settle_caravan(&settle, &m, at, Some(true), false),
            Ok(())
        );
        // early
        let early = At { now: 99, ..at };
        assert_eq!(
            judge_settle_caravan(&settle, &m, early, Some(true), false)
                .unwrap_err()
                .0,
            CARAVAN_MISMATCH
        );
        // credited twice
        va[VA::store(1)..VA::store(1) + 8].copy_from_slice(&14_000i64.to_le_bytes());
        m.after.insert(vault, Some(va));
        assert_eq!(
            judge_settle_caravan(&settle, &m, at, Some(true), false)
                .unwrap_err()
                .0,
            VAULT_MISMATCH
        );
        // a lost destination recorded delivered
        let mut gone = vb;
        gone[VA::GEN] = 2;
        m.before.insert(vault, gone);
        assert_eq!(
            judge_settle_caravan(&settle, &m, at, Some(true), false)
                .unwrap_err()
                .0,
            CARAVAN_MISMATCH
        );
    }
}
