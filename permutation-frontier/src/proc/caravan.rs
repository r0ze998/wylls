//! S1 (redesign stage 1, 1b): vaults and caravans
//! (`docs/frontier/stage1b/S1-1B-CONTRACT.md`).
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xB0 | BuildVault | [`build_vault`] |
//! | 0xB1 | SendCaravan | [`send_caravan`] |
//! | 0xB2 | SettleCaravan | [`settle_caravan`] |
//! | 0xB3 | RaidCaravan | [`raid_caravan`] |
//! | 0xB4 | SeizeVault | [`seize_vault`] |
//! | 0xB5 | CloseVault | [`close_vault`] |
//! | 0xB6 | DefaultRaid | [`default_raid`] |
//!
//! Pinned here:
//! - **Places.** A caravan's origin and destination are a live Holding (its
//!   site's tile) or a live Vault (its tile), of a given generation; a
//!   taken caravan's new origin is the raid's field tile (kind 3 in the log).
//! - **The path** is the caravan kernel's walk (`caravan::walk`) over the
//!   listed Provinces' masks, the origin's Province first; the schedule
//!   (`caravan::schedule`) claims one reusable slot in every Province where
//!   the caravan stands at a bell start (`ProvinceBusy` when none).
//! - **Sends to another player** need the wallet (`WalletRequired`); a
//!   session key moves goods only between the actor's own places.
//! - **The fee** (≥ `CARAVAN_FEE`) waits in the Caravan and pays whoever
//!   settles it; a beneficiary that would stay below rent exemption gets
//!   nothing and the fee goes with the rent to `RENT_TO`.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::{host_id, split_host_id};
use frontier_abi::clash_model::RAID_POS_DOMESTIC;
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::province::caravan_slot as CS;
use frontier_abi::v2::layout::s1::{caravan as CV, place as PL, vault as VA};
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{
    caravan_outcome, close_key_caravan, close_key_vault, log_cleared, log_place, log_run,
    raid_choice, CqKind,
};
use frontier_abi::v2::tags::Ix as Ix2;
use frontier_abi::v2::CqError;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::caravan::{
    self as kc, caravan_id, CaravanSlot, Land, Run, CARAVAN_FEE, MAX_CARAVAN_SLOTS, MAX_VAULTS,
    RAID_BURN_AFTER_BELLS, RAID_DECIDE_BELLS, RAID_NONE, RAID_SETTLED, VAULT_CAP,
};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use permutation_rules::frontier::structure::{self as ks, Watch};
use permutation_rules::frontier::ticket as kt;

use super::conquest::{
    absent, check_accounts_v2, cq, cqlog, presence_v2, present_v2, season_v2, Chained2,
};
use super::holding::{self as hold, Player};
use crate::addr::{self, AddrCtx};
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{
    camp as CP, citizen2 as C, holding2 as H, province2 as P, season2 as S, Ro, Rw,
};
use crate::prologue::{self, expect_key, key};
use crate::{FrontierError, R};
use frontier_abi::v2::log::EntityKind as E2;

const NO_BELL: u32 = u32::MAX;

fn kind(k: CqKind) -> u8 {
    k as u8
}

// ------------------------------------------------------------ places

/// A caravan's origin or destination, resolved against its account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Place {
    pub(crate) kind: u8,
    pub(crate) p: i16,
    pub(crate) q: i16,
    /// Holding: the site; vault: the tile.
    pub(crate) at: u8,
    pub(crate) gen: u8,
    /// The hex tile.
    pub(crate) tile: u8,
    /// The owning Citizen.
    pub(crate) owner: [u8; 32],
}

impl Place {
    fn coord(&self) -> ProvinceCoord {
        ProvinceCoord::new(self.p as i32, self.q as i32)
    }

    /// The logged form (8 B, `log_place`).
    pub(crate) fn log(&self) -> [u8; log_place::LEN] {
        let mut b = [0u8; log_place::LEN];
        b[0] = self.kind;
        b[1..3].copy_from_slice(&self.p.to_le_bytes());
        b[3..5].copy_from_slice(&self.q.to_le_bytes());
        b[5] = self.at;
        b[6] = self.gen;
        b[7] = self.tile;
        b
    }

    /// The stored form (16 B, `layout::s1::place`).
    fn store(&self, d: &mut [u8], at: usize) -> R<()> {
        let mut w = Rw(d);
        w.set_u8(at + PL::KIND, self.kind)?;
        w.set_i16(at + PL::P, self.p)?;
        w.set_i16(at + PL::Q, self.q)?;
        w.set_u8(at + PL::SITE_OR_TILE, self.at)?;
        w.set_u8(at + PL::GEN, self.gen)?;
        w.set_u8(at + PL::TILE, self.tile)
    }

    fn load(d: &[u8], at: usize) -> R<Place> {
        let r = Ro(d);
        Ok(Place {
            kind: r.u8(at + PL::KIND)?,
            p: r.i16(at + PL::P)?,
            q: r.i16(at + PL::Q)?,
            at: r.u8(at + PL::SITE_OR_TILE)?,
            gen: r.u8(at + PL::GEN)?,
            tile: r.u8(at + PL::TILE)?,
            owner: [0; 32],
        })
    }

    /// The account address of the place.
    pub(crate) fn address(&self, ctx: &AddrCtx) -> R<[u8; 32]> {
        match self.kind {
            PL::KIND_HOLDING => Ok(ctx.holding(self.p as i32, self.q as i32, self.at)),
            PL::KIND_VAULT => Ok(frontier_abi::v2::addr::vault(
                ctx,
                self.p as i32,
                self.q as i32,
                self.at,
            )),
            _ => Err(FrontierError::BadData.into()),
        }
    }
}

/// The live place `ai` is (a v2 Holding in state 1–2, or a live Vault),
/// at its canonical address; `None` when absent.
pub(crate) fn place_of(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<Option<Place>> {
    let magic = {
        let d = ai.try_borrow_data()?;
        d.get(..8).map(|m| {
            let mut a = [0u8; 8];
            a.copy_from_slice(m);
            a
        })
    };
    if init::is_absent(ai) {
        return Ok(None);
    }
    match magic {
        Some(m) if m == H::MAGIC => {
            present_v2(ai, p, K2::Holding, sid)?;
            let d = ai.try_borrow_data()?;
            let r = Ro(&d);
            let pl = Place {
                kind: PL::KIND_HOLDING,
                p: r.i16(H::P)?,
                q: r.i16(H::Q)?,
                at: r.u8(H::SITE)?,
                gen: r.u8(H::GEN)?,
                tile: r.u8(H::TILE)?,
                owner: r.arr(H::OWNER_CITIZEN)?,
            };
            expect_key(ai, &pl.address(ctx)?)?;
            let st = r.u8(H::STATE)?;
            Ok((st == H::STATE_PROVISIONAL || st == H::STATE_FINAL).then_some(pl))
        }
        Some(m) if m == VA::MAGIC => {
            present_v2(ai, p, K2::Vault, sid)?;
            let d = ai.try_borrow_data()?;
            let r = Ro(&d);
            let pl = Place {
                kind: PL::KIND_VAULT,
                p: r.i16(VA::P)?,
                q: r.i16(VA::Q)?,
                at: r.u8(VA::TILE)?,
                gen: r.u8(VA::GEN)?,
                tile: r.u8(VA::TILE)?,
                owner: r.arr(VA::OWNER_CITIZEN)?,
            };
            expect_key(ai, &pl.address(ctx)?)?;
            Ok((r.u8(VA::STATE)? == VA::STATE_LIVE).then_some(pl))
        }
        _ => Err(BAD_ACCOUNT),
    }
}

/// The destination named by instruction data, at `ai`: canonical, live, of
/// the named generation (`BadData` otherwise).
fn named_place(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    ai: &AccountInfo,
    (kind, dp, dq, at, gen): (u8, i16, i16, u8, u8),
) -> R<Place> {
    let want = Place {
        kind,
        p: dp,
        q: dq,
        at,
        gen,
        tile: 0,
        owner: [0; 32],
    };
    expect_key(ai, &want.address(ctx)?)?;
    match place_of(p, ctx, sid, ai)? {
        Some(pl) if pl.kind == kind && pl.gen == gen => Ok(pl),
        _ => Err(FrontierError::BadData.into()),
    }
}

// ------------------------------------------------------------ provinces

/// A path Province: canonical, present (v2), its masks and `resolved_next`.
pub(super) fn land_of(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<(Land, u32)> {
    present_v2(ai, p, K2::Province, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let (pp, pq) = (r.i16(P::P)?, r.i16(P::Q)?);
    expect_key(ai, &ctx.province(pp as i32, pq as i32))?;
    Ok((
        Land {
            at: ProvinceCoord::new(pp as i32, pq as i32),
            passable: r.u64(P::PASSABLE_MASK)?,
            rough: r.u64(P::ROUGH_MASK)?,
            road: r.u64(P::ROAD_MASK)?,
        },
        r.u32(P::RESOLVED_NEXT)?,
    ))
}

fn read_slot(pd: &[u8], i: usize) -> R<CaravanSlot> {
    CaravanSlot::decode(pd.get(CS::at(i)..CS::at(i) + CS::SIZE).ok_or(BAD_ACCOUNT)?)
        .ok_or(BAD_ACCOUNT)
}

fn write_slot(pd: &mut [u8], i: usize, s: &CaravanSlot) -> R<()> {
    s.encode(
        pd.get_mut(CS::at(i)..CS::at(i) + CS::SIZE)
            .ok_or(BAD_ACCOUNT)?,
    )
    .ok_or(BAD_ACCOUNT)
}

/// The slot of caravan `id` in a Province (index and record).
fn slot_of(pd: &[u8], id: u64) -> R<Option<(usize, CaravanSlot)>> {
    for i in 0..MAX_CARAVAN_SLOTS {
        let s = read_slot(pd, i)?;
        if s.id == id {
            return Ok(Some((i, s)));
        }
    }
    Ok(None)
}

/// Writes `run` of caravan `id` into a reusable slot (`ProvinceBusy` when
/// none; a run must start at an unresolved bell).
fn claim_slot(pd: &mut [u8], id: u64, faction: u8, run: &Run) -> R<()> {
    let rn = Ro(pd).u32(P::RESOLVED_NEXT)?;
    if run.first_bell < rn {
        return Err(FrontierError::BadData.into());
    }
    let slot = CaravanSlot::of_run(id, faction, run).ok_or(FrontierError::BadData)?;
    for i in 0..MAX_CARAVAN_SLOTS {
        if read_slot(pd, i)?.reusable(rn) {
            return write_slot(pd, i, &slot);
        }
    }
    Err(cq(CqError::ProvinceBusy))
}

// ------------------------------------------------------------ the walk and the slots

/// Walks `path` from `origin` to `dst` over `provinces` (the origin's
/// first) at the owner's caravan speed and writes the schedule's slots.
/// Returns the arrival time, the runs as logged (`log_run`), the last
/// bell and the tower wear (1d, `S1-1D-CONTRACT` §3.3: the seconds walked in
/// the hostile coverage of the towers standing now).
#[allow(clippy::too_many_arguments)]
fn route(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    genesis_ts: i64,
    now: i64,
    origin: (ProvinceCoord, u8),
    dst: (ProvinceCoord, u8),
    steps: u8,
    path: &[u8; 12],
    faction: u8,
    who: &Owner,
    id: u64,
    provinces: &[AccountInfo],
) -> R<(i64, [u8; log_run::LEN * log_run::N], u32, u16)> {
    let mut lands = [Land {
        at: ProvinceCoord::new(0, 0),
        passable: 0,
        rough: 0,
        road: 0,
    }; 4];
    for (l, ai) in lands.iter_mut().zip(provinces) {
        *l = land_of(p, ctx, sid, ai)?.0;
    }
    let lands = &lands[..provinces.len()];
    let bps = of_faction_v3(faction).ok_or(BAD_ACCOUNT)?.caravan_time_bps;
    // A caravan taken on its destination's own tile has no step to
    // walk: it arrives at once, with no slot (only a raid can start on its
    // destination; a send's two places never share a tile).
    if steps == 0 {
        if origin != dst {
            return Err(FrontierError::Path.into());
        }
        return Ok((now, [0u8; log_run::LEN * log_run::N], 0, 0));
    }
    let walked = kc::walk(origin, path, steps, lands, bps).map_err(|_| FrontierError::Path)?;
    let last = walked.last().ok_or(FrontierError::Path)?;
    if (last.province, last.tile) != dst {
        return Err(FrontierError::Path.into());
    }
    let runs = kc::schedule(genesis_ts, now, origin, &walked).map_err(|_| FrontierError::Path)?;
    // 1d/1e: what the caravan meets on the way (the structures standing
    // now): a stopping palisade refuses the walk, stopping towers wear it.
    let mut watch = [Watch::default(); 4];
    for (w, ai) in watch.iter_mut().zip(provinces) {
        *w =
            super::structure::watch_of(&ai.try_borrow_data()?, &who.stances, faction, who.expelled);
    }
    let met = ks::caravan_watch(&walked, |pc| {
        lands
            .iter()
            .zip(watch)
            .find(|(l, _)| l.at == pc)
            .map_or(Watch::default(), |(_, w)| w)
    });
    let worn = match met {
        ks::Walked::Secs(secs) => ks::wear_bps(secs),
        ks::Walked::Blocked => return Err(FrontierError::Path.into()),
    };
    let mut logged = [0u8; log_run::LEN * log_run::N];
    let mut last_bell = 0u32;
    for (i, run) in runs.iter().enumerate() {
        let ai = provinces
            .iter()
            .zip(lands)
            .find(|(_, l)| l.at == run.province)
            .map(|(a, _)| a)
            .ok_or(FrontierError::Path)?;
        {
            let mut pd = ai.try_borrow_mut_data()?;
            claim_slot(&mut pd, id, faction, run)?;
        }
        let o = i * log_run::LEN;
        let e = logged
            .get_mut(o..o + log_run::LEN)
            .ok_or(FrontierError::Path)?;
        e[0..2].copy_from_slice(&(run.province.p as i16).to_le_bytes());
        e[2..4].copy_from_slice(&(run.province.q as i16).to_le_bytes());
        e[4..8].copy_from_slice(&run.first_bell.to_le_bytes());
        e[8] = run.tiles.len() as u8;
        last_bell = last_bell.max(run.first_bell + run.tiles.len() as u32 - 1);
    }
    let arrive = now
        .checked_add(kc::travel_secs(&walked) as i64)
        .ok_or(OVERFLOW)?;
    Ok((arrive, logged, last_bell, worn))
}

/// Whose a caravan's walk is, for what its structures do (S1 1e): the
/// Season's stances and whether the owner is expelled from its nation.
#[derive(Clone, Copy)]
struct Owner {
    stances: ks::Stances,
    expelled: bool,
}

impl Owner {
    /// The Season's stances and the Citizen's expelled state.
    fn of(season: &AccountInfo, citizen: &AccountInfo) -> R<Owner> {
        Ok(Owner {
            stances: super::structure::stances_of(&season.try_borrow_data()?),
            expelled: Ro(&citizen.try_borrow_data()?).i64(C::EXPELLED_SINCE)? != 0,
        })
    }
}

/// `cargo` worn by `bps` (`structure::wear` on each amount).
fn worn_cargo(cargo: &[i64; RESOURCES], bps: u16) -> [i64; RESOURCES] {
    cargo.map(|c| permutation_rules::frontier::structure::wear_i64(c, bps))
}

/// The cargo's eight amounts as the logged `u32` whole units.
fn cargo_log(cargo: &[i64; RESOURCES]) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (r, v) in cargo.iter().enumerate() {
        let u = (v.max(&0) / MILLI).min(u32::MAX as i64) as u32;
        b[4 * r..4 * r + 4].copy_from_slice(&u.to_le_bytes());
    }
    b
}

/// Creates the Caravan account and writes its fields.
#[allow(clippy::too_many_arguments)]
fn create_caravan<'a>(
    p: &Pubkey,
    payer: &AccountInfo<'a>,
    season_ai: &AccountInfo<'a>,
    signer: &SeasonSigner,
    caravan: &AccountInfo<'a>,
    sid: u64,
    owner: &[u8; 32],
    owner_tag: u64,
    seq: u32,
    faction: u8,
    src: &Place,
    dst: &Place,
    steps: u8,
    path: &[u8; 12],
    provinces: &[AccountInfo<'a>],
    now: i64,
    arrive: i64,
    last_bell: u32,
    cargo: &[i64; RESOURCES],
    fee: u64,
) -> R<()> {
    absent(caravan)?;
    let seed = frontier_abi::v2::addr::caravan_seed(owner_tag, seq);
    let rent = init::rent(CV::SIZE)?;
    init::init_with_seed(payer, caravan, season_ai, signer, &seed, CV::SIZE, rent, p)?;
    init::transfer(payer, caravan, fee)?;
    let mut d = caravan.try_borrow_mut_data()?;
    if !frontier_abi::v2::layout::write_header(&mut d, K2::Caravan, sid) {
        return Err(BAD_ACCOUNT);
    }
    let mut w = Rw(&mut d);
    w.set_arr(CV::OWNER_CITIZEN, owner)?;
    w.set_u64(CV::OWNER_TAG, owner_tag)?;
    w.set_u32(CV::SEQ, seq)?;
    w.set_u8(CV::FACTION, faction)?;
    w.set_u8(CV::STATE, CV::STATE_MOVING)?;
    w.set_u8(CV::STEPS, steps)?;
    w.set_u8(CV::N_PROV, provinces.len() as u8)?;
    w.set_arr(CV::PATH, path)?;
    for (i, ai) in provinces.iter().enumerate() {
        let pd = ai.try_borrow_data()?;
        let r = Ro(&pd);
        w.set_i16(CV::province(i), r.i16(P::P)?)?;
        w.set_i16(CV::province(i) + 2, r.i16(P::Q)?)?;
    }
    w.set_i64(CV::DEPART_TS, now)?;
    w.set_i64(CV::ARRIVE_TS, arrive)?;
    w.set_u32(CV::LAST_BELL, last_bell)?;
    for (r, v) in cargo.iter().enumerate() {
        w.set_i64(CV::cargo(r), *v)?;
    }
    w.set_u64(CV::FEE, fee)?;
    w.set_arr(CV::RENT_TO, payer.key.as_ref())?;
    src.store(&mut d, CV::SRC)?;
    dst.store(&mut d, CV::DST)
}

/// The CARAVAN_SENT payload.
#[allow(clippy::too_many_arguments)]
fn sent_payload(
    faction: u8,
    src: &[u8; 8],
    dst: &[u8; 8],
    steps: u8,
    cargo: &[i64; RESOURCES],
    arrive: i64,
    runs: &[u8; log_run::LEN * log_run::N],
    worn_bps: u16,
    path: &[u8; 12],
) -> R<crate::events::Buf<108>> {
    Ok(crate::events::Buf::<108>::new()
        .u8(faction)
        .bytes(src)
        .bytes(dst)
        .u8(steps)
        .bytes(&cargo_log(cargo))
        .i64(arrive)
        .bytes(runs)
        .u16(worn_bps)
        .bytes(path))
}

fn caravan_key(owner_tag: u64, seq: u32) -> [u8; 12] {
    let mut k = [0u8; 12];
    k[..8].copy_from_slice(&owner_tag.to_le_bytes());
    k[8..].copy_from_slice(&seq.to_le_bytes());
    k
}

/// The Provinces among `provinces` whose slot a record changed, as chain
/// entries (the ones with a run, in the order given).
fn province_links<'b, 'a>(
    provinces: &'b [AccountInfo<'a>],
    runs: &[u8; log_run::LEN * log_run::N],
) -> R<alloc::vec::Vec<core::cell::RefMut<'b, &'a mut [u8]>>> {
    let mut out = alloc::vec::Vec::new();
    for i in 0..log_run::N {
        let e = &runs[i * log_run::LEN..(i + 1) * log_run::LEN];
        if e[8] == 0 {
            continue;
        }
        let (rp, rq) = (
            i16::from_le_bytes([e[0], e[1]]),
            i16::from_le_bytes([e[2], e[3]]),
        );
        for ai in provinces {
            let hit = {
                let pd = ai.try_borrow_data()?;
                let r = Ro(&pd);
                (r.i16(P::P)?, r.i16(P::Q)?) == (rp, rq)
            };
            if hit {
                out.push(ai.try_borrow_mut_data()?);
                break;
            }
        }
    }
    Ok(out)
}

extern crate alloc;

// ------------------------------------------------------------ 0xB0 BuildVault

/// 0xB0 BuildVault(tile): P + `[holding w] [holding_province r] [province
/// r] [vault w] [system]` (contract §3.1).
pub fn build_vault(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::BuildVault, a, None)?;
    let x = ix2::BuildVault::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, holding, holding_province, province, vault, _system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let hh = hold::owned_holding(p, &pl, holding, citizen)?;
    hold::live(&hh)?;
    hold::own_province_unlocked(p, &pl, &hh, holding_province)?;
    hold::finality(&pl, &hh, holding, citizen, holding_province)?;
    // The tile.
    let (land, _) = land_of(p, &pl.ctx, sid, province)?;
    let (vp, vq) = (land.at.p, land.at.q);
    {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        let n = (r.u8(P::SITE_COUNT)? as usize).min(P::SITES_N);
        let sites: [u8; 12] = r.arr(P::SITES)?;
        let keep = frontier_abi::conquest_model::read_keep(&pd)?.map(|k| k.tile);
        let camp = r.u8(P::CAMP + CP::TILE)?;
        let camp_present = r.u8(P::CAMP + CP::STATE)? == CP::STATE_PRESENT;
        let ok = (x.tile as usize) < 61
            && land.passable & (1u64 << x.tile) != 0
            && !sites[..n].contains(&x.tile)
            && keep != Some(x.tile)
            && !(camp_present && camp == x.tile);
        if !ok {
            return Err(cq(CqError::VaultSite));
        }
    }
    expect_key(
        vault,
        &frontier_abi::v2::addr::vault(&pl.ctx, vp, vq, x.tile),
    )?;
    if !init::is_absent(vault) {
        return Err(cq(CqError::VaultSite));
    }
    let faction = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(C::VAULTS)? >= MAX_VAULTS {
            return Err(cq(CqError::VaultLimit));
        }
        r.u8(C::FACTION)?
    };
    // The cost, from the holding.
    let now = pl.now.ts;
    let mut h = hold::load_touched(holding, now)?;
    let cost = kc::vault_cost();
    h.pay(now, &cost).map_err(hold::holding_err)?;
    {
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    }
    // The vault.
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    let seed = frontier_abi::v2::addr::vault_seed(vp, vq, x.tile);
    let rent = init::rent(VA::SIZE)?;
    init::init_with_seed(payer, vault, season_ai, &signer, &seed, VA::SIZE, rent, p)?;
    let owner_tag = pl.pc.citizen_tag;
    {
        let mut vd = vault.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut vd, K2::Vault, sid) {
            return Err(BAD_ACCOUNT);
        }
        let mut w = Rw(&mut vd);
        w.set_i16(VA::P, vp as i16)?;
        w.set_i16(VA::Q, vq as i16)?;
        w.set_u8(VA::TILE, x.tile)?;
        w.set_u8(VA::STATE, VA::STATE_LIVE)?;
        w.set_u8(VA::FACTION, faction)?;
        w.set_u8(VA::GEN, 1)?;
        w.set_arr(VA::OWNER_CITIZEN, citizen.key.as_ref())?;
        w.set_u64(VA::OWNER_TAG, owner_tag)?;
        w.set_i64(VA::BUILT_TS, now)?;
        w.set_i64(VA::CAP, VAULT_CAP)?;
        w.set_u32(VA::SEIZED_BELL, NO_BELL)?;
        w.set_arr(VA::RENT_TO, payer.key.as_ref())?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(C::VAULTS)?;
        Rw(&mut cd).set_u8(C::VAULTS, v + 1)?;
    }
    let mut key9 = [0u8; 9];
    key9[..4].copy_from_slice(&vp.to_le_bytes());
    key9[4..8].copy_from_slice(&vq.to_le_bytes());
    key9[8] = x.tile;
    let hkey = host_id(hh.p as i32, hh.q as i32, hh.site, hh.gen, 0).ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<50>::new()
        .u64(owner_tag)
        .u8(faction)
        .u8(1)
        .u64(hkey)
        .bytes(&hold::cost_digest(&cost));
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut vd = vault.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::VAULT_BUILT),
        pl.pc.now_bell,
        &key9,
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Holding,
                data: &mut hd,
            },
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB1 SendCaravan

/// 0xB1 SendCaravan: P + `[src w] [dst r] [caravan w] [system]
/// [path_province w ×1..4]` (contract §3.2).
pub fn send_caravan(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(8)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::SendCaravan, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::SendCaravan::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, src, dst, caravan, _system, provinces @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let cargo = ix2::cargo_milli(&x.cargo).ok_or(FrontierError::BadData)?;
    let order = SendOrder {
        seq: x.seq,
        dst: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
        steps: x.steps,
        path: x.path,
        fee: x.fee,
    };
    let accounts = SendAccounts {
        payer,
        season_ai,
        citizen,
        src,
        dst,
        caravan,
        provinces,
    };
    send(p, &pl, &accounts, &order, &cargo, false)
}

/// What a send names besides its cargo (SendCaravan, WithdrawShares).
pub(crate) struct SendOrder {
    pub(crate) seq: u32,
    pub(crate) dst: (u8, i16, i16, u8, u8),
    pub(crate) steps: u8,
    pub(crate) path: [u8; 12],
    pub(crate) fee: u64,
}

/// The accounts of a send.
pub(crate) struct SendAccounts<'b, 'a> {
    pub(crate) payer: &'b AccountInfo<'a>,
    pub(crate) season_ai: &'b AccountInfo<'a>,
    pub(crate) citizen: &'b AccountInfo<'a>,
    pub(crate) src: &'b AccountInfo<'a>,
    pub(crate) dst: &'b AccountInfo<'a>,
    pub(crate) caravan: &'b AccountInfo<'a>,
    pub(crate) provinces: &'b [AccountInfo<'a>],
}

/// Whether a vault's bytes are shared (S2 2b): its share issue
/// `(issuer_tag, seq)` when it is.
pub(crate) fn vault_shares(vd: &[u8]) -> R<Option<(u64, u32)>> {
    let r = Ro(vd);
    if r.u8(VA::SHARES_ON)? == 0 {
        return Ok(None);
    }
    Ok(Some((
        r.u64(VA::SHARES_ISSUER_TAG)?,
        r.u32(VA::SHARES_SEQ)?,
    )))
}

/// A caravan of `cargo` (milli) out of `a.src` (SendCaravan's body). With
/// `withdraw` the source is a shared vault the caller checked (2b
/// WithdrawShares); otherwise it is the actor's own place, not a shared
/// vault.
pub(crate) fn send(
    p: &Pubkey,
    pl: &Player,
    a: &SendAccounts,
    x: &SendOrder,
    cargo: &[i64; RESOURCES],
    withdraw: bool,
) -> R<()> {
    let SendAccounts {
        payer,
        season_ai,
        citizen,
        src,
        dst,
        caravan,
        provinces,
    } = *a;
    let sid = pl.pc.season.id;
    let now = pl.now.ts;
    let (seq, faction) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (r.u32(C::CARAVANS)?, r.u8(C::FACTION)?)
    };
    if x.seq != seq || x.fee < CARAVAN_FEE {
        return Err(FrontierError::BadData.into());
    }
    if cargo.iter().all(|&v| v == 0) {
        return Err(FrontierError::BadData.into());
    }
    // The source: the actor's own live place (a shared vault only through
    // shares); a holding is capture-locked in its own Province, the path's
    // first.
    let s = place_of(p, &pl.ctx, sid, src)?.ok_or(FrontierError::NotFinal)?;
    if withdraw {
        if s.kind != PL::KIND_VAULT {
            return Err(BAD_ACCOUNT);
        }
    } else {
        if s.owner != citizen.key.to_bytes() {
            return Err(FrontierError::NotOwner.into());
        }
        if s.kind == PL::KIND_VAULT && vault_shares(&src.try_borrow_data()?)?.is_some() {
            return Err(cq(CqError::VaultShared));
        }
    }
    let first = provinces.first().ok_or(FrontierError::TooManyAccounts)?;
    expect_key(first, &pl.ctx.province(s.p as i32, s.q as i32))?;
    if s.kind == PL::KIND_HOLDING {
        let hh = hold::owned_holding(p, pl, src, citizen)?;
        hold::own_province_unlocked(p, pl, &hh, first)?;
        hold::finality(pl, &hh, src, citizen, first)?;
    }
    // The destination.
    let t = named_place(p, &pl.ctx, sid, dst, x.dst)?;
    if dst.key == src.key {
        return Err(FrontierError::BadData.into());
    }
    // Plan §1-11: a send to another player needs the wallet.
    if t.owner != citizen.key.to_bytes() && pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    // Debit the source.
    if s.kind == PL::KIND_HOLDING {
        let mut h = hold::load_touched(src, now)?;
        h.pay(now, cargo).map_err(hold::holding_err)?;
        let mut hd = src.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    } else {
        let mut vd = src.try_borrow_mut_data()?;
        for (r, c) in cargo.iter().enumerate() {
            let have = Ro(&vd).i64(VA::store(r))?;
            if have < *c {
                return Err(FrontierError::Insufficient.into());
            }
            Rw(&mut vd).set_i64(VA::store(r), have - c)?;
        }
        let sent = Ro(&vd).u32(VA::SENT)?;
        Rw(&mut vd).set_u32(VA::SENT, sent.saturating_add(1))?;
    }
    // The path and the slots.
    let owner_tag = pl.pc.citizen_tag;
    let id = caravan_id(owner_tag, seq);
    let (arrive, runs, last_bell, worn) = route(
        p,
        &pl.ctx,
        sid,
        pl.pc.season.genesis_ts,
        now,
        (s.coord(), s.tile),
        (t.coord(), t.tile),
        x.steps,
        &x.path,
        faction,
        &Owner::of(season_ai, citizen)?,
        id,
        provinces,
    )?;
    // The Caravan.
    expect_key(
        caravan,
        &frontier_abi::v2::addr::caravan(&pl.ctx, owner_tag, seq),
    )?;
    // 1d: the towers on the route wear the cargo now; the source paid the
    // whole.
    let cargo = worn_cargo(cargo, worn);
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    create_caravan(
        p,
        payer,
        season_ai,
        &signer,
        caravan,
        sid,
        &citizen.key.to_bytes(),
        owner_tag,
        seq,
        faction,
        &s,
        &t,
        x.steps,
        &x.path,
        provinces,
        now,
        arrive,
        last_bell,
        &cargo,
        x.fee,
    )?;
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        Rw(&mut cd).set_u32(C::CARAVANS, seq.checked_add(1).ok_or(OVERFLOW)?)?;
    }
    let payload = sent_payload(
        faction,
        &s.log(),
        &t.log(),
        x.steps,
        &cargo,
        arrive,
        &runs,
        worn,
        &x.path,
    )?;
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut sd = src.try_borrow_mut_data()?;
    let mut vd = caravan.try_borrow_mut_data()?;
    let mut pds = province_links(provinces, &runs)?;
    let mut chained: alloc::vec::Vec<Chained2> = alloc::vec::Vec::with_capacity(7);
    chained.push(Chained2 {
        entity: E2::Citizen,
        data: &mut cd,
    });
    chained.push(Chained2 {
        entity: if s.kind == PL::KIND_HOLDING {
            E2::Holding
        } else {
            E2::Vault
        },
        data: &mut sd,
    });
    for pd in pds.iter_mut() {
        chained.push(Chained2 {
            entity: E2::Province,
            data: pd,
        });
    }
    chained.push(Chained2 {
        entity: E2::Caravan,
        data: &mut vd,
    });
    cqlog::emit(
        kind(CqKind::CARAVAN_SENT),
        pl.pc.now_bell,
        &caravan_key(owner_tag, seq),
        payload.get()?,
        &mut chained,
    )
}

// ------------------------------------------------------------ the caravan account

/// A present Caravan at its canonical address: its owner tag and sequence.
fn caravan_of(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<(u64, u32)> {
    present_v2(ai, p, K2::Caravan, sid)?;
    let cd = ai.try_borrow_data()?;
    let r = Ro(&cd);
    let (tag, seq) = (r.u64(CV::OWNER_TAG)?, r.u32(CV::SEQ)?);
    expect_key(ai, &frontier_abi::v2::addr::caravan(ctx, tag, seq))?;
    Ok((tag, seq))
}

/// The Caravan's provinces as stored, checked against the listed ones in
/// order (`BadAccount`).
fn listed_provinces(ctx: &AddrCtx, cd: &[u8], provinces: &[AccountInfo]) -> R<()> {
    let r = Ro(cd);
    let n = r.u8(CV::N_PROV)? as usize;
    if n != provinces.len() {
        return Err(FrontierError::TooManyAccounts.into());
    }
    for (i, ai) in provinces.iter().enumerate() {
        let (pp, pq) = (r.i16(CV::province(i))?, r.i16(CV::province(i) + 2)?);
        expect_key(ai, &ctx.province(pp as i32, pq as i32))?;
    }
    Ok(())
}

/// Closes a settled Caravan to its `RENT_TO` after logging `CLOSE`.
fn close_caravan<'a>(
    p: &Pubkey,
    caravan: &AccountInfo<'a>,
    rent_to: &AccountInfo<'a>,
    tag: u64,
    seq: u32,
    bell: u32,
) -> R<()> {
    let lamports = caravan.lamports();
    {
        let mut md = caravan.try_borrow_mut_data()?;
        let (s, head) = crate::layout::chain_of(&md)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(s)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            &close_key_caravan(tag, seq),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Caravan,
                data: &mut md,
            }],
        )?;
    }
    init::close_to(p, caravan, rent_to, &Sink::Never, bell)?;
    Ok(())
}

// ------------------------------------------------------------ 0xB2 SettleCaravan

/// 0xB2 SettleCaravan(beneficiary): `[fee_payer s] [season] [caravan w]
/// [dst w] [beneficiary w] [rent_to w] [path_province r ×1..4]`
/// (contract §3.4).
pub fn settle_caravan(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(6)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::SettleCaravan, a, Some(&[1, n_prov as u8]))?;
    let x = ix2::SettleCaravan::decode(d)?;
    let [fee_payer, season_ai, caravan, dst, beneficiary, rent_to, provinces @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let fixed = [fee_payer, season_ai, caravan, dst, beneficiary, rent_to];
    settle(p, fixed, provinces, &x.beneficiary, None)
}

/// 0xC5 SettleDeposit(beneficiary) (S2 2b): `[fee_payer s] [season]
/// [caravan w] [dst w] [beneficiary w] [rent_to w] [issue w] [lot w]
/// [system] [path_province r ×1..4]`: SettleCaravan into a shared vault,
/// minting the caravan owner's shares (`S2-2B-CONTRACT.md` §3.3).
pub fn settle_deposit(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(9)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::SettleDeposit, a, Some(&[1, n_prov as u8]))?;
    let x = ix2::SettleDeposit::decode(d)?;
    let [fee_payer, season_ai, caravan, dst, beneficiary, rent_to, issue, lot, _system, provinces @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let fixed = [fee_payer, season_ai, caravan, dst, beneficiary, rent_to];
    settle(p, fixed, provinces, &x.beneficiary, Some((issue, lot)))
}

/// SettleCaravan's body; with `deposit` (the share issue and the deposit
/// lot) the destination must be a live shared vault, without it must not.
fn settle<'a>(
    p: &Pubkey,
    fixed: [&AccountInfo<'a>; 6],
    provinces: &[AccountInfo<'a>],
    beneficiary_key: &[u8; 32],
    deposit: Option<(&AccountInfo<'a>, &AccountInfo<'a>)>,
) -> R<()> {
    let [fee_payer, season_ai, caravan, dst, beneficiary, rent_to] = fixed;
    let now = prologue::now()?;
    if beneficiary.key.to_bytes() != *beneficiary_key {
        return Err(BAD_ACCOUNT);
    }
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let sid = hdr.id;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let bell = hdr.bell(now.ts).unwrap_or(NO_BELL);
    let (tag, seq) = caravan_of(p, &ctx, sid, caravan)?;
    let id = caravan_id(tag, seq);
    let (dplace, cargo, fee, holder) = {
        let cd = caravan.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(CV::STATE)? != CV::STATE_MOVING {
            return Err(FrontierError::AlreadyDone.into());
        }
        if now.ts < r.i64(CV::ARRIVE_TS)? {
            return Err(cq(CqError::CaravanEarly));
        }
        if r.arr::<32>(CV::RENT_TO)? != rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
        listed_provinces(&ctx, &cd, provinces)?;
        let mut cargo = [0i64; RESOURCES];
        for (i, c) in cargo.iter_mut().enumerate() {
            *c = r.i64(CV::cargo(i))?;
        }
        (
            Place::load(&cd, CV::DST)?,
            cargo,
            r.u64(CV::FEE)?,
            r.arr::<32>(CV::OWNER_CITIZEN)?,
        )
    };
    // Every bell the caravan stood here is resolved and no raid is open.
    for ai in provinces {
        present_v2(ai, p, K2::Province, sid)?;
        let pd = ai.try_borrow_data()?;
        if let Some((_, s)) = slot_of(&pd, id)? {
            if Ro(&pd).u32(P::RESOLVED_NEXT)? <= s.last_bell() {
                return Err(cq(CqError::CaravanEarly));
            }
            if s.raid_open() {
                return Err(cq(CqError::RaidState));
            }
        }
    }
    // Deliver, or lose the cargo.
    expect_key(dst, &dplace.address(&ctx)?)?;
    let live = match place_of(p, &ctx, sid, dst)? {
        Some(pl) => pl.kind == dplace.kind && pl.gen == dplace.gen,
        None => false,
    };
    if deposit.is_some() && !(live && dplace.kind == PL::KIND_VAULT) {
        // A lost delivery or a holding: SettleCaravan's.
        return Err(BAD_ACCOUNT);
    }
    // 2b: `(issue, value before, value after)` of a delivery into a shared
    // vault.
    let mut shared: Option<((u64, u32), u128, u128)> = None;
    let outcome = if live {
        if dplace.kind == PL::KIND_HOLDING {
            // A capture-locked holding waits for SettleCapture.
            let pk = ctx.province(dplace.p as i32, dplace.q as i32);
            let pai = provinces
                .iter()
                .find(|ai| ai.key.to_bytes() == pk)
                .ok_or(cq(CqError::CaravanEarly))?;
            {
                let pd = pai.try_borrow_data()?;
                match frontier_abi::v2::prologue::capture_locked(&pd, dplace.at, dplace.gen) {
                    Some(false) => {}
                    Some(true) => return Err(cq(CqError::CapturePending)),
                    None => return Err(BAD_ACCOUNT),
                }
            }
            let (mut h, ore) = {
                let hd = dst.try_borrow_data()?;
                (hold::read_holding(&hd)?, hold::terrain_ore(&hd)?)
            };
            hold::settle_tiered(&mut h, now.ts, ore)?;
            for (r, c) in cargo.iter().enumerate() {
                if *c > 0 {
                    h.credit(now.ts, Resource::ALL[r], *c)
                        .map_err(hold::holding_err)?;
                }
            }
            let mut hd = dst.try_borrow_mut_data()?;
            hold::write_holding(&mut hd, &h, now.ts)?;
        } else {
            let mut vd = dst.try_borrow_mut_data()?;
            let shares = vault_shares(&vd)?;
            match (shares, deposit) {
                (Some(_), None) => return Err(cq(CqError::VaultShared)),
                (None, Some(_)) => return Err(BAD_ACCOUNT),
                _ => {}
            }
            let cap = Ro(&vd).i64(VA::CAP)?;
            let mut before = [0i64; RESOURCES];
            let mut after = [0i64; RESOURCES];
            for (r, c) in cargo.iter().enumerate() {
                let have = Ro(&vd).i64(VA::store(r))?;
                let to = have.saturating_add(*c).min(cap.max(have));
                Rw(&mut vd).set_i64(VA::store(r), to)?;
                (before[r], after[r]) = (have, to);
            }
            shared = shares.map(|k| (k, kt::value_of(&before), kt::value_of(&after)));
        }
        caravan_outcome::DELIVERED
    } else {
        caravan_outcome::LOST
    };
    // 2b: the deposit lot is created (a CPI) before any lamports move.
    let at = shared.map(|_| super::ticket::DepositAt {
        ctx: &ctx,
        sid,
        bump: hdr.bump,
        bell,
        vault_gen: dplace.gen,
        caravan: (tag, seq),
    });
    let new_lot = match (&at, shared, deposit) {
        (Some(at), Some((issue_key, ..)), Some((issue, lot))) => {
            super::ticket::deposit_lot(p, at, fee_payer, season_ai, issue, lot, issue_key, &holder)?
        }
        _ => false,
    };
    {
        let mut cd = caravan.try_borrow_mut_data()?;
        Rw(&mut cd).set_u8(
            CV::STATE,
            if live {
                CV::STATE_DELIVERED
            } else {
                CV::STATE_LOST
            },
        )?;
    }
    // The fee to the settler (a beneficiary that would stay below rent
    // exemption gets nothing: the fee goes with the rent).
    let below = init::diverts(
        beneficiary.lamports(),
        fee,
        init::rent(beneficiary.data_len())?,
    )
    .ok_or(OVERFLOW)?;
    let paid = if below { 0 } else { fee };
    init::move_lamports(caravan, beneficiary, paid)?;
    let payload = crate::events::Buf::<49>::new()
        .u8(outcome)
        .bytes(&dplace.log())
        .bytes(&cargo_log(&cargo))
        .u64(paid);
    {
        let mut cd = caravan.try_borrow_mut_data()?;
        if live {
            let mut dd = dst.try_borrow_mut_data()?;
            cqlog::emit(
                kind(CqKind::CARAVAN_SETTLED),
                bell,
                &caravan_key(tag, seq),
                payload.get()?,
                &mut [
                    Chained2 {
                        entity: if dplace.kind == PL::KIND_HOLDING {
                            E2::Holding
                        } else {
                            E2::Vault
                        },
                        data: &mut dd,
                    },
                    Chained2 {
                        entity: E2::Caravan,
                        data: &mut cd,
                    },
                ],
            )?;
        } else {
            cqlog::emit(
                kind(CqKind::CARAVAN_SETTLED),
                bell,
                &caravan_key(tag, seq),
                payload.get()?,
                &mut [Chained2 {
                    entity: E2::Caravan,
                    data: &mut cd,
                }],
            )?;
        }
    }
    if let (Some((issue_key, v0, v1)), Some(at), Some((issue, lot))) = (shared, &at, deposit) {
        super::ticket::deposit(
            p,
            at,
            issue,
            lot,
            issue_key,
            &holder,
            v1.saturating_sub(v0),
            v0,
            new_lot,
        )?;
    }
    close_caravan(p, caravan, rent_to, tag, seq, bell)
}

// ------------------------------------------------------------ 0xB3 RaidCaravan, 0xB6 DefaultRaid
//
// Decision J2: a raid that takes makes the raided caravan the raider's. Its
// cargo stays in it; it leaves the raid tile for the raider's holding or
// vault on a new public path, with slots like any caravan (a visible target
// that can be raided back). Its old route's slots are cleared, so no clash
// sees it where it no longer goes. `OWNER_TAG` stays the address seed (the
// sender's); `OWNER_CITIZEN` and `FACTION` are the holder's. A burn destroys
// the cargo and the empty caravan goes on to its destination.

/// What a raid settlement needs from its accounts.
struct RaidCtx<'a, 'b> {
    p: &'b Pubkey,
    ctx: AddrCtx,
    sid: u64,
    genesis_ts: i64,
    now: i64,
    bell: u32,
    season: &'b AccountInfo<'a>,
    caravan: &'b AccountInfo<'a>,
    raider_holding: &'b AccountInfo<'a>,
    raider_citizen: &'b AccountInfo<'a>,
    /// The new walk's Provinces first (the raid's first), then the old
    /// route's others.
    provinces: &'b [AccountInfo<'a>],
}

/// The open raid of the caravan's slot in the raid Province
/// (`provinces[0]`): `(slot index, slot, raid bell, owner tag, seq)`;
/// `RaidState` when none is open.
fn open_raid(rc: &RaidCtx, raid_pq: (i16, i16)) -> R<(usize, CaravanSlot, u32, u64, u32)> {
    let (tag, seq) = caravan_of(rc.p, &rc.ctx, rc.sid, rc.caravan)?;
    {
        let cd = rc.caravan.try_borrow_data()?;
        if Ro(&cd).u8(CV::STATE)? != CV::STATE_MOVING {
            return Err(cq(CqError::RaidState));
        }
    }
    let first = rc.provinces.first().ok_or(FrontierError::TooManyAccounts)?;
    expect_key(first, &rc.ctx.province(raid_pq.0 as i32, raid_pq.1 as i32))?;
    present_v2(first, rc.p, K2::Province, rc.sid)?;
    let pd = first.try_borrow_data()?;
    let (i, s) = slot_of(&pd, caravan_id(tag, seq))?.ok_or(cq(CqError::RaidState))?;
    if !s.raid_open() {
        return Err(cq(CqError::RaidState));
    }
    let raid_bell = s.first_bell + s.raid_off as u32;
    Ok((i, s, raid_bell, tag, seq))
}

/// The raider: `(tag, faction)` of the Citizen owning the raiding host's
/// holding, which `raider_citizen` must be (`NotOwner`).
fn raider_of(rc: &RaidCtx, slot: &CaravanSlot) -> R<(u64, u8)> {
    let parts = split_host_id(slot.raider).ok_or(BAD_ACCOUNT)?;
    expect_key(
        rc.raider_holding,
        &rc.ctx
            .holding(parts.province.p, parts.province.q, parts.site),
    )?;
    present_v2(rc.raider_holding, rc.p, K2::Holding, rc.sid)?;
    {
        let hd = rc.raider_holding.try_borrow_data()?;
        let r = Ro(&hd);
        if r.u8(H::GEN)? != parts.gen {
            return Err(BAD_ACCOUNT);
        }
        if r.arr::<32>(H::OWNER_CITIZEN)? != rc.raider_citizen.key.to_bytes() {
            return Err(FrontierError::NotOwner.into());
        }
    }
    let cd = rc.raider_citizen.try_borrow_data()?;
    let r = Ro(&cd);
    Ok((r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?))
}

/// Clears every slot of caravan `id` in the old route's Provinces (each
/// must be listed); returns the ones other than the raid's.
fn clear_route(rc: &RaidCtx, id: u64, raid_pq: (i16, i16)) -> R<alloc::vec::Vec<(i16, i16)>> {
    let old: alloc::vec::Vec<(i16, i16)> = {
        let cd = rc.caravan.try_borrow_data()?;
        let r = Ro(&cd);
        let n = (r.u8(CV::N_PROV)? as usize).min(4);
        (0..n)
            .map(|i| Ok((r.i16(CV::province(i))?, r.i16(CV::province(i) + 2)?)))
            .collect::<R<_>>()?
    };
    let mut cleared = alloc::vec::Vec::new();
    for (op, oq) in old {
        let want = rc.ctx.province(op as i32, oq as i32);
        let ai = rc
            .provinces
            .iter()
            .find(|a| a.key.to_bytes() == want)
            .ok_or(FrontierError::TooManyAccounts)?;
        present_v2(ai, rc.p, K2::Province, rc.sid)?;
        let mut pd = ai.try_borrow_mut_data()?;
        for i in 0..MAX_CARAVAN_SLOTS {
            if read_slot(&pd, i)?.id == id {
                write_slot(&mut pd, i, &CaravanSlot::default())?;
            }
        }
        if (op, oq) != raid_pq {
            cleared.push((op, oq));
        }
    }
    Ok(cleared)
}

/// Settles an open raid (shared by RaidCaravan and DefaultRaid): `BURN`,
/// or `TAKE` to `dst` (the raider's place) along `path` over the first
/// `n_path` listed Provinces.
#[allow(clippy::too_many_arguments)]
fn settle_raid(
    rc: &RaidCtx,
    raid_pq: (i16, i16),
    choice: u8,
    by: u8,
    n_path: u8,
    dst: Option<Place>,
    steps: u8,
    path: &[u8; 12],
) -> R<()> {
    let (si, slot, raid_bell, tag, seq) = open_raid(rc, raid_pq)?;
    let id = caravan_id(tag, seq);
    // A default burn (the raiding holding gone) has no raider to check and
    // logs tag 0.
    let default_burn = by == raid_choice::BY_DEFAULT && choice == raid_choice::BURN;
    let (raider_tag, raider_faction) = if default_burn {
        (0, 0)
    } else {
        raider_of(rc, &slot)?
    };
    let mut cargo = [0i64; RESOURCES];
    {
        let cd = rc.caravan.try_borrow_data()?;
        for (r, c) in cargo.iter_mut().enumerate() {
            *c = Ro(&cd).i64(CV::cargo(r))?;
        }
    }
    let raid_tile = *slot.tiles.get(slot.raid_off as usize).ok_or(BAD_ACCOUNT)?;
    let raid_coord = ProvinceCoord::new(raid_pq.0 as i32, raid_pq.1 as i32);
    let mut cleared = alloc::vec::Vec::new();
    let mut sent = None;
    let mut dst_log = [0u8; log_place::LEN];
    if choice == raid_choice::BURN {
        let mut cd = rc.caravan.try_borrow_mut_data()?;
        for r in 0..RESOURCES {
            Rw(&mut cd).set_i64(CV::cargo(r), 0)?;
        }
        drop(cd);
        let mut pd = rc.provinces[0].try_borrow_mut_data()?;
        let mut s = slot;
        s.raid_off = RAID_SETTLED;
        write_slot(&mut pd, si, &s)?;
    } else {
        let t = dst.ok_or(FrontierError::BadData)?;
        if t.owner != rc.raider_citizen.key.to_bytes() {
            return Err(FrontierError::BadData.into());
        }
        let n = n_path as usize;
        if n == 0 || n > 4 || n > rc.provinces.len() {
            return Err(FrontierError::BadData.into());
        }
        cleared = clear_route(rc, id, raid_pq)?;
        let new_route = &rc.provinces[..n];
        let (arrive, runs, last_bell, worn) = route(
            rc.p,
            &rc.ctx,
            rc.sid,
            rc.genesis_ts,
            rc.now,
            (raid_coord, raid_tile),
            (t.coord(), t.tile),
            steps,
            path,
            raider_faction,
            &Owner::of(rc.season, rc.raider_citizen)?,
            id,
            new_route,
        )?;
        // Every listed Province is the new walk's or the old route's.
        for ai in &rc.provinces[n..] {
            let k = ai.key.to_bytes();
            let old = cleared
                .iter()
                .chain(core::iter::once(&raid_pq))
                .any(|(cp, cq)| rc.ctx.province(*cp as i32, *cq as i32) == k);
            if !old {
                return Err(FrontierError::TooManyAccounts.into());
            }
        }
        let field = Place {
            kind: log_place::KIND_FIELD,
            p: raid_pq.0,
            q: raid_pq.1,
            at: raid_tile,
            gen: 0,
            tile: raid_tile,
            owner: [0; 32],
        };
        {
            let mut cd = rc.caravan.try_borrow_mut_data()?;
            let mut w = Rw(&mut cd);
            w.set_arr(CV::OWNER_CITIZEN, rc.raider_citizen.key.as_ref())?;
            w.set_u8(CV::FACTION, raider_faction)?;
            w.set_u8(CV::STEPS, steps)?;
            w.set_u8(CV::N_PROV, n as u8)?;
            w.set_arr(CV::PATH, path)?;
            for i in 0..4 {
                let (pp, pq) = match new_route.get(i) {
                    Some(ai) => {
                        let pd = ai.try_borrow_data()?;
                        let r = Ro(&pd);
                        (r.i16(P::P)?, r.i16(P::Q)?)
                    }
                    None => (0, 0),
                };
                w.set_i16(CV::province(i), pp)?;
                w.set_i16(CV::province(i) + 2, pq)?;
            }
            w.set_i64(CV::DEPART_TS, rc.now)?;
            w.set_i64(CV::ARRIVE_TS, arrive)?;
            w.set_u32(CV::LAST_BELL, last_bell)?;
            // 1d: the new route's towers wear the cargo.
            for (r, c) in worn_cargo(&cargo, worn).iter().enumerate() {
                w.set_i64(CV::cargo(r), *c)?;
            }
            field.store(&mut cd, CV::SRC)?;
            t.store(&mut cd, CV::DST)?;
        }
        dst_log = t.log();
        sent = Some((runs, field.log(), t, arrive, worn));
    }
    // CARAVAN_RAIDED: the raid's Province, the old route's others it
    // cleared, the caravan.
    let cleared_b = log_cleared::write(&cleared).ok_or(BAD_ACCOUNT)?;
    // 1e (K4): a raid RaidDomestic opened is logged as domestic.
    let domestic = slot.raid_pos == RAID_POS_DOMESTIC;
    let payload = crate::events::Buf::<80>::new()
        .bytes(&(raid_pq.0 as i32).to_le_bytes())
        .bytes(&(raid_pq.1 as i32).to_le_bytes())
        .u32(raid_bell)
        .u8(choice)
        .u8(by)
        .u64(raider_tag)
        .bytes(&cargo_log(&cargo))
        .bytes(&dst_log)
        .bytes(&cleared_b)
        .u8(domestic as u8);
    {
        let mut pds = alloc::vec::Vec::with_capacity(4);
        pds.push(rc.provinces[0].try_borrow_mut_data()?);
        for (cp, cq) in &cleared {
            let k = rc.ctx.province(*cp as i32, *cq as i32);
            if let Some(ai) = rc.provinces.iter().find(|a| a.key.to_bytes() == k) {
                pds.push(ai.try_borrow_mut_data()?);
            }
        }
        let mut cd = rc.caravan.try_borrow_mut_data()?;
        let mut chained: alloc::vec::Vec<Chained2> = alloc::vec::Vec::with_capacity(6);
        for pd in pds.iter_mut() {
            chained.push(Chained2 {
                entity: E2::Province,
                data: pd,
            });
        }
        chained.push(Chained2 {
            entity: E2::Caravan,
            data: &mut cd,
        });
        cqlog::emit(
            kind(CqKind::CARAVAN_RAIDED),
            rc.bell,
            &caravan_key(tag, seq),
            payload.get()?,
            &mut chained,
        )?;
    }
    // A take: the caravan's new route (CARAVAN_SENT, origin the field).
    if let Some((runs, src, t, arrive, worn)) = sent {
        let payload = sent_payload(
            raider_faction,
            &src,
            &t.log(),
            steps,
            &worn_cargo(&cargo, worn),
            arrive,
            &runs,
            worn,
            path,
        )?;
        let mut cd = rc.caravan.try_borrow_mut_data()?;
        let mut pds = province_links(rc.provinces, &runs)?;
        let mut chained: alloc::vec::Vec<Chained2> = alloc::vec::Vec::with_capacity(5);
        for pd in pds.iter_mut() {
            chained.push(Chained2 {
                entity: E2::Province,
                data: pd,
            });
        }
        chained.push(Chained2 {
            entity: E2::Caravan,
            data: &mut cd,
        });
        cqlog::emit(
            kind(CqKind::CARAVAN_SENT),
            rc.bell,
            &caravan_key(tag, seq),
            payload.get()?,
            &mut chained,
        )?;
    }
    Ok(())
}

/// 0xB3 RaidCaravan: P (the raider) + `[caravan w] [raider_holding r] [dst
/// r] [path_province w ×1..7]` (contract §3.5, decision J2).
pub fn raid_caravan(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(7)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::RaidCaravan, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::RaidCaravan::decode(d)?;
    if x.choice != raid_choice::TAKE && x.choice != raid_choice::BURN {
        return Err(FrontierError::BadData.into());
    }
    let pl: Player = hold::player(p, a)?;
    let [_, _payer, season_ai, citizen, caravan, raider_holding, dst, provinces @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let rc = RaidCtx {
        p,
        ctx: pl.ctx,
        sid: pl.pc.season.id,
        genesis_ts: pl.pc.season.genesis_ts,
        now: pl.now.ts,
        bell: pl.pc.now_bell,
        season: season_ai,
        caravan,
        raider_holding,
        raider_citizen: citizen,
        provinces,
    };
    // The raider's window.
    let (_, _, raid_bell, _, _) = open_raid(&rc, (x.p, x.q))?;
    if pl.pc.now_bell > raid_bell.saturating_add(RAID_DECIDE_BELLS) {
        return Err(cq(CqError::RaidWindow));
    }
    let to = if x.choice == raid_choice::TAKE {
        Some(named_place(
            p,
            &pl.ctx,
            pl.pc.season.id,
            dst,
            (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
        )?)
    } else {
        None
    };
    settle_raid(
        &rc,
        (x.p, x.q),
        x.choice,
        raid_choice::BY_RAIDER,
        x.n_path,
        to,
        x.steps,
        &x.path,
    )
}

/// 0xB6 DefaultRaid: `[fee_payer s] [season] [caravan w] [raider_holding r]
/// [raider_citizen r] [beneficiary w] [path_province w ×1..7]`: after the
/// raider's window, a take to the raiding host's own holding (contract
/// §3.5), or a burn when that holding is gone or, from
/// `RAID_BURN_AFTER_BELLS` after the window, when no walk home is given.
/// The keeper is paid the caravan's escrowed fee; the caravan then
/// settles with none.
pub fn default_raid(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(6)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::DefaultRaid, a, Some(&[1, n_prov as u8]))?;
    let x = ix2::DefaultRaid::decode(d)?;
    let now = prologue::now()?;
    let [_fee_payer, season_ai, caravan, raider_holding, raider_citizen, beneficiary, provinces @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if beneficiary.key.to_bytes() != x.beneficiary {
        return Err(BAD_ACCOUNT);
    }
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let bell = hdr.bell(now.ts).unwrap_or(NO_BELL);
    let rc = RaidCtx {
        p,
        ctx,
        sid: hdr.id,
        genesis_ts: hdr.genesis_ts,
        now: now.ts,
        bell,
        season: season_ai,
        caravan,
        raider_holding,
        raider_citizen,
        provinces,
    };
    let (_, slot, raid_bell, _, _) = open_raid(&rc, (x.p, x.q))?;
    if bell <= raid_bell.saturating_add(RAID_DECIDE_BELLS) {
        return Err(cq(CqError::RaidWindow));
    }
    // The caravan goes home: the raiding host's own holding, while it stands
    // (live, same generation); otherwise the cargo burns.
    let parts = split_host_id(slot.raider).ok_or(BAD_ACCOUNT)?;
    let home = place_of(p, &ctx, hdr.id, raider_holding)?.filter(|t| {
        (t.p as i32, t.q as i32, t.at, t.gen)
            == (parts.province.p, parts.province.q, parts.site, parts.gen)
    });
    // No walk home given (`steps` 0 off the home tile): a burn, allowed
    // only `RAID_BURN_AFTER_BELLS` after the window (a raid never stays
    // open for good; a keeper has a day to take the caravan home).
    let raid_tile = *slot.tiles.get(slot.raid_off as usize).ok_or(BAD_ACCOUNT)?;
    let unreachable =
        home.is_some_and(|t| x.steps == 0 && ((t.p, t.q) != (x.p, x.q) || t.tile != raid_tile));
    if unreachable
        && bell
            <= raid_bell
                .saturating_add(RAID_DECIDE_BELLS)
                .saturating_add(RAID_BURN_AFTER_BELLS)
    {
        return Err(cq(CqError::RaidWindow));
    }
    let home = home.filter(|_| !unreachable);
    let choice = if home.is_some() {
        raid_choice::TAKE
    } else {
        raid_choice::BURN
    };
    settle_raid(
        &rc,
        (x.p, x.q),
        choice,
        raid_choice::BY_DEFAULT,
        x.n_path,
        home,
        x.steps,
        &x.path,
    )?;
    // The keeper's pay: the caravan's escrowed fee (contract §4.4), unless
    // the beneficiary would stay below rent exemption.
    let fee = {
        let cd = caravan.try_borrow_data()?;
        Ro(&cd).u64(CV::FEE)?
    };
    let below = init::diverts(
        beneficiary.lamports(),
        fee,
        init::rent(beneficiary.data_len())?,
    )
    .ok_or(OVERFLOW)?;
    if !below && fee > 0 {
        init::move_lamports(caravan, beneficiary, fee)?;
        let mut cd = caravan.try_borrow_mut_data()?;
        Rw(&mut cd).set_u64(CV::FEE, 0)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xBE RaidDomestic

/// 0xBE RaidDomestic(bell, entry): P + `[caravan r] [province w]
/// [host_holding r] [owner_citizen r]` (1e contract §4, decision K4). A
/// clash never raids a caravan of the raider's own faction; here a village
/// shows that its host stood where such a caravan stood: the caravan's
/// slot in the Province had it on a tile at `bell` (resolved, and at most
/// `RAID_DECIDE_BELLS` ago, not raided there before), the actor's roster
/// host `entry` has stood on that tile since `bell` or earlier, and none of
/// the owner's hosts stands there (`NotOnTile`). The slot's raid then opens
/// as a clash opens it, its position `RAID_POS_DOMESTIC`; RaidCaravan or
/// DefaultRaid settles it.
pub fn raid_domestic(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    use frontier_abi::layout::province::entry as E;
    check_accounts_v2(Ix2::RaidDomestic, a, None)?;
    let x = ix2::RaidDomestic::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _payer, _season, citizen, caravan, province, host_holding, owner_citizen] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let now_bell = pl.pc.now_bell;
    let (tag, seq) = caravan_of(p, &pl.ctx, sid, caravan)?;
    let id = caravan_id(tag, seq);
    let (owner, cfaction) = {
        let cd = caravan.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(CV::STATE)? != CV::STATE_MOVING {
            return Err(cq(CqError::RaidState));
        }
        (r.arr::<32>(CV::OWNER_CITIZEN)?, r.u8(CV::FACTION)?)
    };
    expect_key(owner_citizen, &owner)?;
    present_v2(owner_citizen, p, K2::Citizen, sid)?;
    let (raider_tag, faction) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?)
    };
    // Domestic only: the caravan is the actor's faction's, not its own.
    if faction != cfaction || owner == citizen.key.to_bytes() {
        return Err(FrontierError::BadData.into());
    }
    if now_bell > x.bell.saturating_add(RAID_DECIDE_BELLS) {
        return Err(cq(CqError::RaidWindow));
    }
    // The owner's holdings (their host ids' holding part).
    let owner_holdings: [u64; 3] = {
        let od = owner_citizen.try_borrow_data()?;
        let mut hs = [u64::MAX; 3];
        for (i, h) in hs.iter_mut().enumerate() {
            let (hp, hq, site, gen) = super::conquest::holding_ref(&od, (i + 1) as u8)?;
            if gen != C::EMPTY_GEN {
                *h = host_id(hp as i32, hq as i32, site, gen, 0).ok_or(BAD_ACCOUNT)?;
            }
        }
        hs
    };
    let holding_part = |id: u64| id & !0xFFFF_FFFF;
    present_v2(province, p, K2::Province, sid)?;
    let (pp, pq, si, mut slot, host) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        let (pp, pq) = (r.i16(P::P)?, r.i16(P::Q)?);
        expect_key(province, &pl.ctx.province(pp as i32, pq as i32))?;
        if x.bell >= r.u32(P::RESOLVED_NEXT)? {
            return Err(cq(CqError::RaidWindow));
        }
        let (si, slot) = slot_of(&pd, id)?.ok_or(cq(CqError::RaidState))?;
        let tile = slot.tile_at(x.bell).ok_or(cq(CqError::RaidState))?;
        for i in 0..P::ENTRIES_N {
            let o = P::entry(i);
            if r.u8(o + E::STATE)? == E::STATE_ROSTER && r.u8(o + E::TILE)? == tile {
                let hid = r.u64(o + E::ID)?;
                if owner_holdings
                    .iter()
                    .any(|&h| h != u64::MAX && holding_part(hid) == h)
                {
                    return Err(cq(CqError::NotOnTile));
                }
            }
        }
        let o = P::entry(x.entry as usize);
        if (x.entry as usize) >= P::ENTRIES_N
            || r.u8(o + E::STATE)? != E::STATE_ROSTER
            || r.u8(o + E::TILE)? != tile
            || r.u32(o + E::FROM_BELL)? > x.bell
        {
            return Err(cq(CqError::NotOnTile));
        }
        (pp, pq, si, slot, r.u64(o + E::ID)?)
    };
    // The raiding host is the actor's.
    let parts = split_host_id(host).ok_or(BAD_ACCOUNT)?;
    expect_key(
        host_holding,
        &pl.ctx
            .holding(parts.province.p, parts.province.q, parts.site),
    )?;
    present_v2(host_holding, p, K2::Holding, sid)?;
    {
        let hd = host_holding.try_borrow_data()?;
        let r = Ro(&hd);
        if r.u8(H::GEN)? != parts.gen || r.arr::<32>(H::OWNER_CITIZEN)? != citizen.key.to_bytes() {
            return Err(cq(CqError::NotOnTile));
        }
    }
    slot.raid_off = u8::try_from(x.bell - slot.first_bell).map_err(|_| OVERFLOW)?;
    slot.raid_pos = RAID_POS_DOMESTIC;
    slot.raider = host;
    write_slot(&mut province.try_borrow_mut_data()?, si, &slot)?;
    let payload = crate::events::Buf::<29>::new()
        .bytes(&(pp as i32).to_le_bytes())
        .bytes(&(pq as i32).to_le_bytes())
        .u32(x.bell)
        .u64(host)
        .u64(raider_tag)
        .u8(1);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::RAID_OPENED),
        now_bell,
        &caravan_key(tag, seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Province,
                data: &mut pd,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB4 SeizeVault

/// 0xB4 SeizeVault(entry): P (the captor) + `[vault w] [province r]
/// [host_holding r] [owner_citizen w]` (contract §3.6).
pub fn seize_vault(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    use frontier_abi::layout::province::entry as E;
    check_accounts_v2(Ix2::SeizeVault, a, None)?;
    let x = ix2::SeizeVault::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _payer, _season, citizen, vault, province, host_holding, owner_citizen] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    present_v2(vault, p, K2::Vault, sid)?;
    let (vp, vq, tile, gen, owner, prev_tag, faction_before) = {
        let vd = vault.try_borrow_data()?;
        let r = Ro(&vd);
        if r.u8(VA::STATE)? != VA::STATE_LIVE {
            return Err(FrontierError::NotFinal.into());
        }
        (
            r.i16(VA::P)?,
            r.i16(VA::Q)?,
            r.u8(VA::TILE)?,
            r.u8(VA::GEN)?,
            r.arr::<32>(VA::OWNER_CITIZEN)?,
            r.u64(VA::OWNER_TAG)?,
            r.u8(VA::FACTION)?,
        )
    };
    expect_key(
        vault,
        &frontier_abi::v2::addr::vault(&pl.ctx, vp as i32, vq as i32, tile),
    )?;
    expect_key(owner_citizen, &owner)?;
    if owner == citizen.key.to_bytes() {
        return Err(FrontierError::BadData.into());
    }
    expect_key(province, &pl.ctx.province(vp as i32, vq as i32))?;
    present_v2(province, p, K2::Province, sid)?;
    // The owner's holdings (their host ids' holding part).
    let owner_holdings: [u64; 3] = {
        let od = owner_citizen.try_borrow_data()?;
        let mut hs = [u64::MAX; 3];
        for (i, h) in hs.iter_mut().enumerate() {
            let (hp, hq, hs_, hg) = super::conquest::holding_ref(&od, (i + 1) as u8)?;
            if hg != C::EMPTY_GEN {
                *h = host_id(hp as i32, hq as i32, hs_, hg, 0).ok_or(BAD_ACCOUNT)?;
            }
        }
        hs
    };
    let holding_part = |id: u64| id & !0xFFFF_FFFF;
    let host = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        let rn = r.u32(P::RESOLVED_NEXT)?;
        // No host of the owner on the tile.
        for i in 0..P::ENTRIES_N {
            let o = P::entry(i);
            if r.u8(o + E::STATE)? == E::STATE_ROSTER && r.u8(o + E::TILE)? == tile {
                let id = r.u64(o + E::ID)?;
                if owner_holdings
                    .iter()
                    .any(|&h| h != u64::MAX && holding_part(id) == h)
                {
                    return Err(cq(CqError::NotOnTile));
                }
            }
        }
        let o = P::entry(x.entry as usize);
        if (x.entry as usize) >= P::ENTRIES_N
            || r.u8(o + E::STATE)? != E::STATE_ROSTER
            || r.u8(o + E::TILE)? != tile
            || r.u32(o + E::FROM_BELL)? > rn
        {
            return Err(cq(CqError::NotOnTile));
        }
        r.u64(o + E::ID)?
    };
    // The captor's host: its holding is the captor's.
    let parts = split_host_id(host).ok_or(BAD_ACCOUNT)?;
    expect_key(
        host_holding,
        &pl.ctx
            .holding(parts.province.p, parts.province.q, parts.site),
    )?;
    present_v2(host_holding, p, K2::Holding, sid)?;
    {
        let hd = host_holding.try_borrow_data()?;
        let r = Ro(&hd);
        if r.u8(H::GEN)? != parts.gen || r.arr::<32>(H::OWNER_CITIZEN)? != citizen.key.to_bytes() {
            return Err(cq(CqError::NotOnTile));
        }
    }
    let (captor_tag, captor_faction) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(C::VAULTS)? >= MAX_VAULTS {
            return Err(cq(CqError::VaultLimit));
        }
        (r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?)
    };
    let new_gen = gen.checked_add(1).ok_or(OVERFLOW)?;
    {
        let mut vd = vault.try_borrow_mut_data()?;
        let mut w = Rw(&mut vd);
        w.set_arr(VA::OWNER_CITIZEN, citizen.key.as_ref())?;
        w.set_u64(VA::OWNER_TAG, captor_tag)?;
        w.set_u8(VA::FACTION, captor_faction)?;
        w.set_u8(VA::GEN, new_gen)?;
        w.set_u32(VA::SEIZED_BELL, pl.pc.now_bell)?;
        // S2 (2b): the shares of the old generation are void.
        w.set_u8(VA::SHARES_ON, 0)?;
        w.set_u32(VA::SHARES_SEQ, 0)?;
        w.set_u64(VA::SHARES_ISSUER_TAG, 0)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(C::VAULTS)?;
        Rw(&mut cd).set_u8(C::VAULTS, v + 1)?;
    }
    {
        let mut od = owner_citizen.try_borrow_mut_data()?;
        let v = Ro(&od).u8(C::VAULTS)?;
        Rw(&mut od).set_u8(C::VAULTS, v.saturating_sub(1))?;
    }
    let mut key9 = [0u8; 9];
    key9[..4].copy_from_slice(&(vp as i32).to_le_bytes());
    key9[4..8].copy_from_slice(&(vq as i32).to_le_bytes());
    key9[8] = tile;
    let payload = crate::events::Buf::<26>::new()
        .u64(captor_tag)
        .u64(prev_tag)
        .u8(new_gen)
        .u8((captor_faction == faction_before) as u8)
        .u64(host);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut od = owner_citizen.try_borrow_mut_data()?;
    let mut vd = vault.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::VAULT_SEIZED),
        pl.pc.now_bell,
        &key9,
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Citizen,
                data: &mut od,
            },
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB5 CloseVault

/// 0xB5 CloseVault: P (the owner, by the wallet) + `[vault w] [rent_to w]`:
/// an empty vault closes to its `RENT_TO` (contract §1.1).
pub fn close_vault(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::CloseVault, a, None)?;
    let _ = ix2::CloseVault::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    if pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    let [_, _payer, _season, citizen, vault, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    present_v2(vault, p, K2::Vault, pl.pc.season.id)?;
    let (vp, vq, tile) = {
        let vd = vault.try_borrow_data()?;
        let r = Ro(&vd);
        if r.arr::<32>(VA::OWNER_CITIZEN)? != citizen.key.to_bytes() {
            return Err(FrontierError::NotOwner.into());
        }
        if r.u8(VA::SHARES_ON)? != 0 {
            return Err(cq(CqError::VaultShared));
        }
        if r.arr::<32>(VA::RENT_TO)? != rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
        for i in 0..RESOURCES {
            if r.i64(VA::store(i))? != 0 {
                return Err(FrontierError::BadData.into());
            }
        }
        (r.i16(VA::P)?, r.i16(VA::Q)?, r.u8(VA::TILE)?)
    };
    expect_key(
        vault,
        &frontier_abi::v2::addr::vault(&pl.ctx, vp as i32, vq as i32, tile),
    )?;
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(C::VAULTS)?;
        Rw(&mut cd).set_u8(C::VAULTS, v.saturating_sub(1))?;
    }
    let lamports = vault.lamports();
    let bell = pl.pc.now_bell;
    {
        let mut vd = vault.try_borrow_mut_data()?;
        let (s, head) = crate::layout::chain_of(&vd)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(s)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            &close_key_vault(vp as i32, vq as i32, tile),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            }],
        )?;
    }
    init::close_to(p, vault, rent_to, &Sink::Never, bell)?;
    let _ = presence_v2;
    let _ = RAID_NONE;
    Ok(())
}
