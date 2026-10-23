//! S1 (redesign stage 1, 1d): watchtowers
//! (`docs/frontier/stage1d/S1-1D-CONTRACT.md`).
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xB7 | BuildTower | [`build_tower`] |
//! | 0xB8 | SeizeTower | [`seize_tower`] |
//! | 0xB9 | CloseTower | [`close_tower`] |
//!
//! A tower is a Tower account (its owner, faction, generation and rent) and
//! an entry of its Province's tower list (`TOWERS @4044`), which is what
//! Reveal and the caravan routes read: [`hostile_of`] derives the coverage
//! a walker of a faction meets there (`tower::hostile`). The three
//! handlers keep the account and the entry in step.
//!
//! Pinned here:
//! - **The tile** follows a vault's rule (`TowerSite`): passable, not a
//!   settlement site, not the keep, not a present camp; one tower a tile.
//! - **The entry** is the list's first empty one (`TowerFull`); the Tower
//!   keeps its index (`ENTRY`), and SeizeTower and CloseTower check that the
//!   entry is this tower's (state live, same tile).
//! - **SeizeTower** is SeizeVault's host rule; the entry's faction and
//!   generation follow the Tower's.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::{host_id, split_host_id};
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::province::tower_entry as TE;
use frontier_abi::v2::layout::s1::tower as TW;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{close_key_tower, CqKind, EntityKind as E2};
use frontier_abi::v2::tags::Ix as Ix2;
use frontier_abi::v2::CqError;
use permutation_rules::frontier::tower::{self as kt, TowerEntry, MAX_TOWERS};

use super::caravan::land_of;
use super::conquest::{check_accounts_v2, cq, cqlog, present_v2, Chained2};
use super::holding::{self as hold, Player};
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{camp as CP, citizen2 as C, holding2 as H, province2 as P, Ro, Rw};
use crate::prologue::expect_key;
use crate::{FrontierError, R};

const NO_BELL: u32 = u32::MAX;

/// The hostile tower coverage a walker of `faction` meets in a Province
/// (`tower::hostile` over its list; an account too short for the list,
/// i.e. not a v2 Province, has none).
pub fn hostile_of(pd: &[u8], faction: u8) -> R<u64> {
    Ok(match pd.get(TE::BLOCK) {
        Some(list) => kt::hostile(list, faction),
        None => 0,
    })
}

fn read_entry(pd: &[u8], i: usize) -> R<TowerEntry> {
    TowerEntry::decode(pd.get(TE::at(i)..TE::at(i) + TE::SIZE).ok_or(BAD_ACCOUNT)?)
        .ok_or(BAD_ACCOUNT)
}

fn write_entry(pd: &mut [u8], i: usize, e: &TowerEntry) -> R<()> {
    e.encode(
        pd.get_mut(TE::at(i)..TE::at(i) + TE::SIZE)
            .ok_or(BAD_ACCOUNT)?,
    )
    .ok_or(BAD_ACCOUNT)
}

/// The record key `p i32 ‖ q i32 ‖ tile`.
fn key9(p: i32, q: i32, tile: u8) -> [u8; 9] {
    let mut k = [0u8; 9];
    k[..4].copy_from_slice(&p.to_le_bytes());
    k[4..8].copy_from_slice(&q.to_le_bytes());
    k[8] = tile;
    k
}

/// A present Tower at its canonical address and its Province's entry for
/// it: `(p, q, tile, entry index)`.
fn tower_of(
    p: &Pubkey,
    pl: &Player,
    tower: &AccountInfo,
    province: &AccountInfo,
) -> R<(i16, i16, u8, usize)> {
    let sid = pl.pc.season.id;
    present_v2(tower, p, K2::Tower, sid)?;
    let (tp, tq, tile, entry) = {
        let td = tower.try_borrow_data()?;
        let r = Ro(&td);
        if r.u8(TW::STATE)? != TW::STATE_LIVE {
            return Err(FrontierError::NotFinal.into());
        }
        (
            r.i16(TW::P)?,
            r.i16(TW::Q)?,
            r.u8(TW::TILE)?,
            r.u8(TW::ENTRY)? as usize,
        )
    };
    expect_key(
        tower,
        &frontier_abi::v2::addr::tower(&pl.ctx, tp as i32, tq as i32, tile),
    )?;
    expect_key(province, &pl.ctx.province(tp as i32, tq as i32))?;
    present_v2(province, p, K2::Province, sid)?;
    let e = read_entry(&province.try_borrow_data()?, entry)?;
    if entry >= TE::N || !e.live || e.tile != tile {
        return Err(BAD_ACCOUNT);
    }
    Ok((tp, tq, tile, entry))
}

// ------------------------------------------------------------ 0xB7 BuildTower

/// 0xB7 BuildTower(tile, notify): P + `[holding w] [holding_province r]
/// [province w] [tower w] [system]` (contract §3.4).
pub fn build_tower(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::BuildTower, a, None)?;
    let x = ix2::BuildTower::decode(d)?;
    if x.notify > TW::NOTIFY_FACTION {
        return Err(FrontierError::BadData.into());
    }
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, holding, holding_province, province, tower, _system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let hh = hold::owned_holding(p, &pl, holding, citizen)?;
    hold::live(&hh)?;
    hold::own_province_unlocked(p, &pl, &hh, holding_province)?;
    hold::finality(&pl, &hh, holding, citizen, holding_province)?;
    // The tile and a free entry.
    let (land, _) = land_of(p, &pl.ctx, sid, province)?;
    let (tp, tq) = (land.at.p, land.at.q);
    let entry = {
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
            return Err(cq(CqError::TowerSite));
        }
        let mut free = None;
        for i in 0..TE::N {
            if !read_entry(&pd, i)?.live {
                free = Some(i);
                break;
            }
        }
        free.ok_or(cq(CqError::TowerFull))?
    };
    expect_key(
        tower,
        &frontier_abi::v2::addr::tower(&pl.ctx, tp, tq, x.tile),
    )?;
    if !init::is_absent(tower) {
        return Err(cq(CqError::TowerSite));
    }
    let faction = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(C::TOWERS)? >= MAX_TOWERS {
            return Err(cq(CqError::TowerLimit));
        }
        r.u8(C::FACTION)?
    };
    // The cost, from the holding.
    let now = pl.now.ts;
    let mut h = hold::load_touched(holding, now)?;
    let cost = kt::tower_cost();
    h.pay(now, &cost).map_err(hold::holding_err)?;
    {
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    }
    // The tower and its entry.
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    let seed = frontier_abi::v2::addr::tower_seed(tp, tq, x.tile);
    let rent = init::rent(TW::SIZE)?;
    init::init_with_seed(payer, tower, season_ai, &signer, &seed, TW::SIZE, rent, p)?;
    let owner_tag = pl.pc.citizen_tag;
    {
        let mut td = tower.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut td, K2::Tower, sid) {
            return Err(BAD_ACCOUNT);
        }
        let mut w = Rw(&mut td);
        w.set_i16(TW::P, tp as i16)?;
        w.set_i16(TW::Q, tq as i16)?;
        w.set_u8(TW::TILE, x.tile)?;
        w.set_u8(TW::STATE, TW::STATE_LIVE)?;
        w.set_u8(TW::FACTION, faction)?;
        w.set_u8(TW::GEN, 1)?;
        w.set_arr(TW::OWNER_CITIZEN, citizen.key.as_ref())?;
        w.set_u64(TW::OWNER_TAG, owner_tag)?;
        w.set_i64(TW::BUILT_TS, now)?;
        w.set_u32(TW::SEIZED_BELL, NO_BELL)?;
        w.set_u8(TW::NOTIFY, x.notify)?;
        w.set_u8(TW::ENTRY, entry as u8)?;
        w.set_arr(TW::RENT_TO, payer.key.as_ref())?;
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        write_entry(
            &mut pd,
            entry,
            &TowerEntry {
                live: true,
                tile: x.tile,
                faction,
                gen: 1,
            },
        )?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(C::TOWERS)?;
        Rw(&mut cd).set_u8(C::TOWERS, v + 1)?;
    }
    let hkey = host_id(hh.p as i32, hh.q as i32, hh.site, hh.gen, 0).ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<52>::new()
        .u64(owner_tag)
        .u8(faction)
        .u8(1)
        .u8(entry as u8)
        .u8(x.notify)
        .u64(hkey)
        .bytes(&hold::cost_digest(&cost));
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    let mut td = tower.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::TOWER_BUILT as u8,
        pl.pc.now_bell,
        &key9(tp, tq, x.tile),
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
                entity: E2::Province,
                data: &mut pd,
            },
            Chained2 {
                entity: E2::Tower,
                data: &mut td,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB8 SeizeTower

/// 0xB8 SeizeTower(entry): P (the captor) + `[tower w] [province w]
/// [host_holding r] [owner_citizen w]` (contract §3.5).
pub fn seize_tower(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    use frontier_abi::layout::province::entry as E;
    check_accounts_v2(Ix2::SeizeTower, a, None)?;
    let x = ix2::SeizeTower::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _payer, _season, citizen, tower, province, host_holding, owner_citizen] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let (tp, tq, tile, entry) = tower_of(p, &pl, tower, province)?;
    let (gen, owner, prev_tag, faction_before) = {
        let td = tower.try_borrow_data()?;
        let r = Ro(&td);
        (
            r.u8(TW::GEN)?,
            r.arr::<32>(TW::OWNER_CITIZEN)?,
            r.u64(TW::OWNER_TAG)?,
            r.u8(TW::FACTION)?,
        )
    };
    expect_key(owner_citizen, &owner)?;
    if owner == citizen.key.to_bytes() {
        return Err(FrontierError::BadData.into());
    }
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
        if r.u8(C::TOWERS)? >= MAX_TOWERS {
            return Err(cq(CqError::TowerLimit));
        }
        (r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?)
    };
    let new_gen = gen.checked_add(1).ok_or(OVERFLOW)?;
    {
        let mut td = tower.try_borrow_mut_data()?;
        let mut w = Rw(&mut td);
        w.set_arr(TW::OWNER_CITIZEN, citizen.key.as_ref())?;
        w.set_u64(TW::OWNER_TAG, captor_tag)?;
        w.set_u8(TW::FACTION, captor_faction)?;
        w.set_u8(TW::GEN, new_gen)?;
        w.set_u32(TW::SEIZED_BELL, pl.pc.now_bell)?;
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        write_entry(
            &mut pd,
            entry,
            &TowerEntry {
                live: true,
                tile,
                faction: captor_faction,
                gen: new_gen,
            },
        )?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(C::TOWERS)?;
        Rw(&mut cd).set_u8(C::TOWERS, v + 1)?;
    }
    {
        let mut od = owner_citizen.try_borrow_mut_data()?;
        let v = Ro(&od).u8(C::TOWERS)?;
        Rw(&mut od).set_u8(C::TOWERS, v.saturating_sub(1))?;
    }
    let payload = crate::events::Buf::<27>::new()
        .u64(captor_tag)
        .u64(prev_tag)
        .u8(new_gen)
        .u8(captor_faction)
        .u8((captor_faction == faction_before) as u8)
        .u64(host);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut od = owner_citizen.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    let mut td = tower.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::TOWER_SEIZED as u8,
        pl.pc.now_bell,
        &key9(tp as i32, tq as i32, tile),
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
                entity: E2::Province,
                data: &mut pd,
            },
            Chained2 {
                entity: E2::Tower,
                data: &mut td,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB9 CloseTower

/// 0xB9 CloseTower: P + `[tower w] [province w] [rent_to w]`, by the
/// wallet (contract §3.6).
pub fn close_tower(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::CloseTower, a, None)?;
    let _ = ix2::CloseTower::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    if pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    let [_, _payer, _season, citizen, tower, province, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let (tp, tq, tile, entry) = tower_of(p, &pl, tower, province)?;
    {
        let td = tower.try_borrow_data()?;
        let r = Ro(&td);
        if r.arr::<32>(TW::OWNER_CITIZEN)? != citizen.key.to_bytes() {
            return Err(FrontierError::NotOwner.into());
        }
        if r.arr::<32>(TW::RENT_TO)? != rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        write_entry(&mut pd, entry, &TowerEntry::default())?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(C::TOWERS)?;
        Rw(&mut cd).set_u8(C::TOWERS, v.saturating_sub(1))?;
    }
    let bell = pl.pc.now_bell;
    {
        let owner_tag = Ro(&tower.try_borrow_data()?).u64(TW::OWNER_TAG)?;
        let payload = crate::events::Buf::<9>::new()
            .u64(owner_tag)
            .u8(entry as u8);
        let mut pd = province.try_borrow_mut_data()?;
        cqlog::emit(
            CqKind::TOWER_CLOSED as u8,
            bell,
            &key9(tp as i32, tq as i32, tile),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Province,
                data: &mut pd,
            }],
        )?;
    }
    let lamports = tower.lamports();
    {
        let mut td = tower.try_borrow_mut_data()?;
        let (s, head) = crate::layout::chain_of(&td)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(s)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            &close_key_tower(tp as i32, tq as i32, tile),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Tower,
                data: &mut td,
            }],
        )?;
    }
    init::close_to(p, tower, rent_to, &Sink::Never, bell)?;
    Ok(())
}
