//! S1 (redesign stage 1, 1d and 1e): structures — towers, palisades and
//! forts (`docs/frontier/stage1d/S1-1D-CONTRACT.md`,
//! `docs/frontier/stage1e/S1-1E-CONTRACT.md` §2).
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xB7 | BuildStructure | [`build_structure`] |
//! | 0xB8 | SeizeStructure | [`seize_structure`] |
//! | 0xB9 | CloseStructure | [`close_structure`] |
//!
//! A structure is a Structure account (its kind, owner, faction,
//! generation and rent) and an entry of its Province's structure list
//! (`STRUCTURES @4044`), which is what Reveal and the caravan routes read:
//! [`watch_of`] derives what a walker meets there (`structure::watch`,
//! under the Season's stances, [`stances_of`]). A fort also has a record in
//! the Province's fort block (`FORTS @4708`: its troops). The handlers keep
//! the account, the entry and the fort record in step.
//!
//! Pinned here:
//! - **The tile** follows a vault's rule (`StructureSite`): passable, not a
//!   settlement site, not the keep, not a present camp; one structure a
//!   tile.
//! - **The entry** is the list's first empty one, and a fort's record the
//!   fort block's first empty one (`StructureFull`); the account keeps the
//!   entry's index (`ENTRY`), and SeizeStructure and CloseStructure check
//!   that the entry is this structure's (its kind and tile).
//! - **Limits** are per kind (`structure::max_of`, the Citizen's
//!   `TOWERS`, `PALISADES`, `FORTS`).
//! - **SeizeStructure** is SeizeVault's host rule; a fort must have fallen
//!   (no troops, the pending ones included: `FortManned`); the entry's and
//!   the fort record's faction and generation follow the account's.
//! - **CloseStructure** of a fort disbands its troops [proposal: they are
//!   lost].

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::{host_id, split_host_id};
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::province::{fort_record as FR, structure_entry as TE};
use frontier_abi::v2::layout::s1::structure as TW;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{close_key_structure, CqKind, EntityKind as E2};
use frontier_abi::v2::tags::Ix as Ix2;
use frontier_abi::v2::CqError;
use permutation_rules::frontier::structure::{
    self as kt, Stances, StructureEntry, Watch, KIND_FORT, KIND_PALISADE, KIND_TOWER,
};

use super::caravan::land_of;
use super::conquest::{check_accounts_v2, cq, cqlog, present_v2, Chained2};
use super::holding::{self as hold, Player};
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{
    camp as CP, citizen2 as C, holding2 as H, province2 as P, season2 as S, Ro, Rw,
};
use crate::prologue::expect_key;
use crate::{FrontierError, R};

const NO_BELL: u32 = u32::MAX;

/// The Season's stance table (S1 1e; a Season too short for it reads all
/// WAR, as does an MC one: its bytes are zero).
pub fn stances_of(sd: &[u8]) -> Stances {
    sd.get(S::STANCES..S::STANCES + kt::NATIONS * kt::NATIONS)
        .and_then(kt::stances_of)
        .unwrap_or([kt::STANCE_WAR; kt::NATIONS * kt::NATIONS])
}

/// What a walker of `faction` (`expelled` from its nation) meets in a
/// Province (`structure::watch` over its list; an account too short for
/// the list, i.e. not a v2 Province, has nothing).
pub fn watch_of(pd: &[u8], stances: &Stances, faction: u8, expelled: bool) -> Watch {
    match pd.get(TE::BLOCK) {
        Some(list) => kt::watch(list, stances, faction, expelled),
        None => Watch::default(),
    }
}

/// The Citizen's counter of `kind`.
fn counter(kind: u8) -> R<usize> {
    match kind {
        KIND_TOWER => Ok(C::TOWERS),
        KIND_PALISADE => Ok(C::PALISADES),
        KIND_FORT => Ok(C::FORTS),
        _ => Err(FrontierError::BadData.into()),
    }
}

/// The live fort record of `tile` in a Province (its index).
pub fn fort_of(pd: &[u8], tile: u8) -> R<usize> {
    let r = Ro(pd);
    for i in 0..FR::N {
        let o = FR::at(i);
        if r.u8(o + FR::STATE)? == FR::STATE_LIVE && r.u8(o + FR::TILE)? == tile {
            return Ok(i);
        }
    }
    Err(BAD_ACCOUNT)
}

/// A fort's troops now (milli), the pending ones included.
fn fort_troops(pd: &[u8], i: usize) -> R<u64> {
    let r = Ro(pd);
    let o = FR::at(i);
    Ok(r.u32(o + FR::TROOPS)? as u64 + r.u16(o + FR::PEND)? as u64 * 1_000)
}

fn read_entry(pd: &[u8], i: usize) -> R<StructureEntry> {
    StructureEntry::decode(pd.get(TE::at(i)..TE::at(i) + TE::SIZE).ok_or(BAD_ACCOUNT)?)
        .ok_or(BAD_ACCOUNT)
}

fn write_entry(pd: &mut [u8], i: usize, e: &StructureEntry) -> R<()> {
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

/// A present Structure at its canonical address and its Province's entry
/// for it: `(p, q, tile, entry index, kind)`.
fn structure_of(
    p: &Pubkey,
    pl: &Player,
    structure: &AccountInfo,
    province: &AccountInfo,
) -> R<(i16, i16, u8, usize, u8)> {
    let sid = pl.pc.season.id;
    present_v2(structure, p, K2::Structure, sid)?;
    let (tp, tq, tile, entry, kind) = {
        let td = structure.try_borrow_data()?;
        let r = Ro(&td);
        if r.u8(TW::STATE)? != TW::STATE_LIVE {
            return Err(FrontierError::NotFinal.into());
        }
        (
            r.i16(TW::P)?,
            r.i16(TW::Q)?,
            r.u8(TW::TILE)?,
            r.u8(TW::ENTRY)? as usize,
            r.u8(TW::KIND)?,
        )
    };
    expect_key(
        structure,
        &frontier_abi::v2::addr::structure(&pl.ctx, tp as i32, tq as i32, tile),
    )?;
    expect_key(province, &pl.ctx.province(tp as i32, tq as i32))?;
    present_v2(province, p, K2::Province, sid)?;
    let e = read_entry(&province.try_borrow_data()?, entry)?;
    if entry >= TE::N || e.kind != kind || e.tile != tile {
        return Err(BAD_ACCOUNT);
    }
    Ok((tp, tq, tile, entry, kind))
}

// ------------------------------------------------------------ 0xB7 BuildStructure

/// 0xB7 BuildStructure(kind, tile, notify): P + `[holding w]
/// [holding_province r|w] [province w] [structure w] [system]` (1d
/// contract §3.4, 1e contract §2).
pub fn build_structure(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::BuildStructure, a, None)?;
    let x = ix2::BuildStructure::decode(d)?;
    if x.notify > TW::NOTIFY_FACTION || !kt::KINDS.contains(&x.kind) {
        return Err(FrontierError::BadData.into());
    }
    let count = counter(x.kind)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, holding, holding_province, province, structure, _system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let hh = hold::owned_holding(p, &pl, holding, citizen)?;
    hold::live(&hh)?;
    hold::own_province_unlocked(p, &pl, &hh, holding_province)?;
    hold::finality(&pl, &hh, holding, citizen, holding_province)?;
    // The tile, a free entry and (a fort) a free fort record.
    let (land, _) = land_of(p, &pl.ctx, sid, province)?;
    let (tp, tq) = (land.at.p, land.at.q);
    let (entry, fort) = {
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
            return Err(cq(CqError::StructureSite));
        }
        let mut free = None;
        for i in 0..TE::N {
            if !read_entry(&pd, i)?.live() {
                free = Some(i);
                break;
            }
        }
        let free = free.ok_or(cq(CqError::StructureFull))?;
        let mut fort = None;
        if x.kind == KIND_FORT {
            for i in 0..FR::N {
                if r.u8(FR::at(i) + FR::STATE)? == FR::STATE_NONE {
                    fort = Some(i);
                    break;
                }
            }
            if fort.is_none() {
                return Err(cq(CqError::StructureFull));
            }
        }
        (free, fort)
    };
    expect_key(
        structure,
        &frontier_abi::v2::addr::structure(&pl.ctx, tp, tq, x.tile),
    )?;
    if !init::is_absent(structure) {
        return Err(cq(CqError::StructureSite));
    }
    let faction = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(count)? >= kt::max_of(x.kind) {
            return Err(cq(CqError::StructureLimit));
        }
        r.u8(C::FACTION)?
    };
    // The cost, from the holding.
    let now = pl.now.ts;
    let mut h = hold::load_touched(holding, now)?;
    let cost = kt::cost(x.kind);
    h.pay(now, &cost).map_err(hold::holding_err)?;
    {
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    }
    // The structure, its entry and (a fort) its record.
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    let seed = frontier_abi::v2::addr::structure_seed(tp, tq, x.tile);
    let rent = init::rent(TW::SIZE)?;
    init::init_with_seed(
        payer,
        structure,
        season_ai,
        &signer,
        &seed,
        TW::SIZE,
        rent,
        p,
    )?;
    let owner_tag = pl.pc.citizen_tag;
    {
        let mut td = structure.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut td, K2::Structure, sid) {
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
        w.set_u8(TW::KIND, x.kind)?;
        w.set_arr(TW::RENT_TO, payer.key.as_ref())?;
    }
    {
        let mut pd = province.try_borrow_mut_data()?;
        write_entry(
            &mut pd,
            entry,
            &StructureEntry {
                kind: x.kind,
                tile: x.tile,
                faction,
                gen: 1,
            },
        )?;
        if let Some(i) = fort {
            let o = FR::at(i);
            let mut w = Rw(&mut pd);
            w.set_u8(o + FR::TILE, x.tile)?;
            w.set_u8(o + FR::FACTION, faction)?;
            w.set_u8(o + FR::GEN, 1)?;
            w.set_u8(o + FR::STATE, FR::STATE_LIVE)?;
            w.set_u32(o + FR::TROOPS, 0)?;
            w.set_u32(o + FR::PEND_BELL, NO_BELL)?;
            w.set_u16(o + FR::PEND, 0)?;
        }
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(count)?;
        Rw(&mut cd).set_u8(count, v + 1)?;
    }
    let hkey = host_id(hh.p as i32, hh.q as i32, hh.site, hh.gen, 0).ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<53>::new()
        .u64(owner_tag)
        .u8(faction)
        .u8(1)
        .u8(entry as u8)
        .u8(x.notify)
        .u64(hkey)
        .bytes(&hold::cost_digest(&cost))
        .u8(x.kind);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    let mut td = structure.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::STRUCTURE_BUILT as u8,
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
                entity: E2::Structure,
                data: &mut td,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB8 SeizeStructure

/// 0xB8 SeizeStructure(entry): P (the captor) + `[structure w] [province
/// w] [host_holding r] [owner_citizen w]` (1d contract §3.5; a fort must
/// have fallen, 1e §2.6).
pub fn seize_structure(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    use frontier_abi::layout::province::entry as E;
    check_accounts_v2(Ix2::SeizeStructure, a, None)?;
    let x = ix2::SeizeStructure::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _payer, _season, citizen, structure, province, host_holding, owner_citizen] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let (tp, tq, tile, entry, kind) = structure_of(p, &pl, structure, province)?;
    let count = counter(kind)?;
    let fort = if kind == KIND_FORT {
        let pd = province.try_borrow_data()?;
        let i = fort_of(&pd, tile)?;
        if fort_troops(&pd, i)? > 0 {
            return Err(cq(CqError::FortManned));
        }
        Some(i)
    } else {
        None
    };
    let (gen, owner, prev_tag, faction_before) = {
        let td = structure.try_borrow_data()?;
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
        if r.u8(count)? >= kt::max_of(kind) {
            return Err(cq(CqError::StructureLimit));
        }
        (r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?)
    };
    let new_gen = gen.checked_add(1).ok_or(OVERFLOW)?;
    {
        let mut td = structure.try_borrow_mut_data()?;
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
            &StructureEntry {
                kind,
                tile,
                faction: captor_faction,
                gen: new_gen,
            },
        )?;
        if let Some(i) = fort {
            let mut w = Rw(&mut pd);
            w.set_u8(FR::at(i) + FR::FACTION, captor_faction)?;
            w.set_u8(FR::at(i) + FR::GEN, new_gen)?;
        }
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(count)?;
        Rw(&mut cd).set_u8(count, v + 1)?;
    }
    {
        let mut od = owner_citizen.try_borrow_mut_data()?;
        let v = Ro(&od).u8(count)?;
        Rw(&mut od).set_u8(count, v.saturating_sub(1))?;
    }
    let payload = crate::events::Buf::<28>::new()
        .u64(captor_tag)
        .u64(prev_tag)
        .u8(new_gen)
        .u8(captor_faction)
        .u8((captor_faction == faction_before) as u8)
        .u64(host)
        .u8(kind);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut od = owner_citizen.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    let mut td = structure.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::STRUCTURE_SEIZED as u8,
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
                entity: E2::Structure,
                data: &mut td,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xB9 CloseStructure

/// 0xB9 CloseStructure: P + `[structure w] [province w] [rent_to w]`, by
/// the wallet (1d contract §3.6; a fort's troops are disbanded).
pub fn close_structure(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::CloseStructure, a, None)?;
    let _ = ix2::CloseStructure::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    if pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    let [_, _payer, _season, citizen, structure, province, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let (tp, tq, tile, entry, kind) = structure_of(p, &pl, structure, province)?;
    let count = counter(kind)?;
    {
        let td = structure.try_borrow_data()?;
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
        write_entry(&mut pd, entry, &StructureEntry::EMPTY)?;
        if kind == KIND_FORT {
            let i = fort_of(&pd, tile)?;
            pd.get_mut(FR::at(i)..FR::at(i) + FR::SIZE)
                .ok_or(BAD_ACCOUNT)?
                .fill(0);
        }
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let v = Ro(&cd).u8(count)?;
        Rw(&mut cd).set_u8(count, v.saturating_sub(1))?;
    }
    let bell = pl.pc.now_bell;
    {
        let owner_tag = Ro(&structure.try_borrow_data()?).u64(TW::OWNER_TAG)?;
        let payload = crate::events::Buf::<10>::new()
            .u64(owner_tag)
            .u8(entry as u8)
            .u8(kind);
        let mut pd = province.try_borrow_mut_data()?;
        cqlog::emit(
            CqKind::STRUCTURE_CLOSED as u8,
            bell,
            &key9(tp as i32, tq as i32, tile),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Province,
                data: &mut pd,
            }],
        )?;
    }
    let lamports = structure.lamports();
    {
        let mut td = structure.try_borrow_mut_data()?;
        let (s, head) = crate::layout::chain_of(&td)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(s)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            &close_key_structure(tp as i32, tq as i32, tile),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Structure,
                data: &mut td,
            }],
        )?;
    }
    init::close_to(p, structure, rent_to, &Sink::Never, bell)?;
    Ok(())
}
