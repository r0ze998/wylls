//! **Player territory on wide land** (territory-impl; owner decisions
//! 2026-11-24 12:09 JST t506s1577, T-1 … T-8; the pure rules are
//! `frontier_abi::world_index::territory`). Four provisional envelope ops:
//!
//! | op | handler | who | what |
//! |---|---|---|---|
//! | 0xDA op 7 WideClaimTile | [`claim_tile_as`] | the player (wallet or NFT resident) | settles the claimer's upkeep from the first home (refused while unpaid), judges the claim (one unowned non-keep tile of an opened wide province of a territory world, within reach of the home, a nation-land province or the claimer's own land, one per turn), burns the ore from the first home, records the tile and its distance to the claimer's nearest village |
//! | 0xDC op 12 WideTerritorySettle | [`settle`] | anyone | settles upkeep from the first home: paid (the food taken) or unpaid since this bell (what the home holds taken, at most the owed amount: Q-LP17-1 (b), r0ze 2026-11-25 21:22) |
//! | 0xDC op 13 WideTerritoryDecay | [`decay`] | anyone | after 24 unpaid turns, one tile of the farthest distance returns to unowned, one per turn; the summary settled this second |
//! | 0xDC op 14 WideTerritoryConquer | [`conquer`] | anyone | after a keep capture (the province's recorded captor, at the keep's current generation, the keep held by the captor's nation), every tile of one non-teammate owner moves to the captor; both summaries settled this second |
//!
//! Every refusal precedes every write; the one CPI (a record's creation)
//! runs before the first byte write. The first home's stores change by the
//! deployed holding kernel (`pay`) and are logged with the deployed
//! `HARVEST` record and stores digest, as WideClaimSite's settler cost is.
//! No PS2/PSW1 record of a territory change is allocated yet (gap: the
//! verifier does not replay these ops; report territory-impl).

use super::{player_start_as, province_at, reach_witness_distance, settle_season, world_of, Shape};
use crate::addr;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner};
use crate::layout::{citizen as C, Ro, Rw};
use crate::proc::holding as hold;
use crate::proc::Auth;
use crate::prologue::{self, check_accounts, expect_key, key, view};
use crate::{FrontierError, R};
use frontier_abi::log::Kind;
use frontier_abi::prologue as ap;
use frontier_abi::world_index::coord::WideCoord;
use frontier_abi::world_index::holding::{self as wh, SlotBinding};
use frontier_abi::world_index::key::WorldId;
use frontier_abi::world_index::land::{self as wl, FIRST_WIDE_RING};
use frontier_abi::world_index::territory::{
    self as wtr, ClaimOk, ReachSource, TerritoryError, TerritoryPlayer, TerritoryProvince,
    TerritoryRule, TileClaim,
};
use frontier_abi::world_index::wide_ix as wix;
use permutation_rules::frontier::holding::RESOURCES;
use permutation_rules::frontier::territory::ClaimRefusal;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

pub(super) fn territory_err(e: TerritoryError) -> crate::Error {
    use FrontierError as F;
    match e {
        TerritoryError::BadTile => F::BadData.into(),
        TerritoryError::KeepTile => F::ReservedSite.into(),
        TerritoryError::Claim(r) => match r {
            ClaimRefusal::NotOpen => F::BadData.into(),
            ClaimRefusal::AlreadyYours => F::AlreadyDone.into(),
            ClaimRefusal::Owned => F::SiteTaken.into(),
            ClaimRefusal::Range => crate::CqError::OutpostRule.into(),
            ClaimRefusal::TurnLimit => F::Cooldown.into(),
            ClaimRefusal::UpkeepUnpaid => F::NotEligible.into(),
            ClaimRefusal::Insufficient => F::Insufficient.into(),
            ClaimRefusal::Overflow => F::Overflow.into(),
        },
        TerritoryError::NotDue => F::TooEarly.into(),
        TerritoryError::NotFarthest => F::OutOfOrder.into(),
        TerritoryError::NotOwner => F::NotOwner.into(),
        TerritoryError::Overflow => F::Overflow.into(),
        TerritoryError::Length { .. }
        | TerritoryError::Magic
        | TerritoryError::Version { .. }
        | TerritoryError::Reserved
        | TerritoryError::Corrupt
        | TerritoryError::Mismatch => BAD_ACCOUNT,
    }
}

/// The territory rule of a wide province's bytes (`NotImplemented` for a
/// province of a world without territory).
fn rule_of(pd: &[u8]) -> R<TerritoryRule> {
    match wl::territory_rule_of(pd) {
        Some(Some(r)) => Ok(r),
        Some(None) => Err(FrontierError::NotImplemented.into()),
        None => Err(BAD_ACCOUNT),
    }
}

/// A territory province record at its canonical address: present (read),
/// or absent (`None`).
fn tprov_at(
    ai: &AccountInfo,
    p: &Pubkey,
    season_id: u64,
    world: WorldId,
    coord: WideCoord,
) -> R<Option<TerritoryProvince>> {
    if ai.data_is_empty() && ai.lamports() == 0 {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let rec = TerritoryProvince::read(&ai.try_borrow_data()?).map_err(territory_err)?;
    if rec.season_id != season_id || rec.world != world || rec.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// A territory player summary at its canonical address: present (read), or
/// absent (`None`).
fn tplayer_at(
    ai: &AccountInfo,
    p: &Pubkey,
    season_id: u64,
    world: WorldId,
    citizen: Option<&[u8; 32]>,
) -> R<Option<TerritoryPlayer>> {
    if ai.data_is_empty() && ai.lamports() == 0 {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let rec = TerritoryPlayer::read(&ai.try_borrow_data()?).map_err(territory_err)?;
    if rec.season_id != season_id
        || rec.world != world
        || citizen.is_some_and(|c| *c != rec.citizen)
    {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(rec))
}

/// The first home of a Citizen's bytes: the legacy binding of slot 1.
fn home_ref(cd: &[u8]) -> R<wh::HoldingRef> {
    match wh::bindings_of(cd).map_err(super::holding_err)?[0] {
        SlotBinding::Legacy(h) => Ok(h),
        _ => Err(crate::CqError::OutpostRule.into()),
    }
}

/// The first home: at its canonical address, the Citizen's, of the bound
/// generation. Returns the holding header.
fn check_home(
    home: &AccountInfo,
    ctx: &addr::AddrCtx,
    season_id: u64,
    citizen: &[u8; 32],
    cd: &[u8],
) -> R<ap::HoldingHdr> {
    let hr = home_ref(cd)?;
    expect_key(home, &ctx.holding(hr.p as i32, hr.q as i32, hr.site))?;
    let hh = {
        let hd = home.try_borrow_data()?;
        ap::check_holding(&view(home, &hd), ctx, season_id, citizen)?
    };
    if hh.gen != hr.gen {
        return Err(FrontierError::BadData.into());
    }
    Ok(hh)
}

/// The upkeep resource's settled stock of a touched first home.
fn upkeep_stock(h: &permutation_rules::frontier::holding::Holding, now: i64, r: u8) -> i64 {
    h.stock_at(now)[r as usize]
}

/// Settles `pl`'s upkeep against the touched first home `h` (in place):
/// the charge is paid from `h` when it covers it. Returns whether `h`'s
/// stores changed.
fn settle_into(
    pl: &mut TerritoryPlayer,
    h: &mut permutation_rules::frontier::holding::Holding,
    now_ts: i64,
    now_bell: u32,
) -> R<bool> {
    let prm = pl.rule.params();
    let avail = upkeep_stock(h, now_ts, prm.upkeep_resource);
    let s = wtr::settle_upkeep(pl, now_ts, now_bell, avail).map_err(territory_err)?;
    if s.charge > 0 {
        let mut cost = [0i64; RESOURCES];
        cost[prm.upkeep_resource as usize] = s.charge;
        h.pay(now_ts, &cost).map_err(hold::holding_err)?;
        return Ok(true);
    }
    Ok(false)
}

/// Writes a touched first home back and logs the deployed `HARVEST` record
/// of its stores.
fn write_home(
    home: &AccountInfo,
    citizen: &AccountInfo,
    hh: &ap::HoldingHdr,
    h: &permutation_rules::frontier::holding::Holding,
    now_ts: i64,
    now_bell: u32,
) -> R<()> {
    let digest = {
        let mut hd = home.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, h, now_ts)?;
        hold::stores_digest(&hd)?
    };
    let hkey = hold::pqs_key(hh.p, hh.q, hh.site)?;
    hold::emit3(Kind::HARVEST, now_bell, &hkey, &digest, citizen, home, None)
}

// ------------------------------------------------------------ 0xDA op 7

/// 0xDA op 7 WideClaimTile (`wide_ix::CLAIM_TILE`).
pub(crate) fn claim_tile_as(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::ClaimTile,
    auth: &Auth,
) -> R<()> {
    check_accounts(Shape(wix::WideCommand::ClaimTile(*x).accounts()), a, None)?;
    if a.len() != x.accounts_len() {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let [_actor, payer, season_ai, citizen, province, tprov_ai, tplayer_ai, home, _home_province, _system, rest @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let (witness_ai, village_ai) = match (x.witness != 0, x.village != 0) {
        (false, false) => (None, None),
        (true, false) => (rest.first(), None),
        (false, true) => (None, rest.first()),
        (true, true) => (rest.first(), rest.get(1)),
    };
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if now_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    // the land: an opened wide province of a territory world
    let coord = WideCoord::checked(x.p, x.q).map_err(|_| FrontierError::BadData)?;
    if coord.ring() < FIRST_WIDE_RING {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    expect_key(province, &wl::province_address(&ctx, coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != coord {
        return Err(BAD_ACCOUNT);
    }
    let (rule, keep_tile) = {
        let pd = province.try_borrow_data()?;
        let keep = frontier_abi::conquest_model::read_keep(&pd)?;
        (rule_of(&pd)?, keep.map_or(wl::NO_TILE, |k| k.tile))
    };
    // the Citizen and its first home (which pays)
    let ckey = key(citizen);
    let (tag, faction, cd_copy) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?, cd.to_vec())
    };
    let hh = check_home(home, &ctx, hdr.id, &ckey, &cd_copy)?;
    if hh.state != crate::layout::holding::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let home_coord =
        WideCoord::checked(hh.p as i64, hh.q as i64).map_err(|_| FrontierError::BadData)?;
    // the records (absent = created below, from the payer)
    expect_key(tprov_ai, &wtr::province_address(&ctx, coord))?;
    expect_key(tplayer_ai, &wtr::player_address(&ctx, &ckey))?;
    let tprov_new = tprov_at(tprov_ai, p, hdr.id, world, coord)?.is_none();
    let mut tprov = match tprov_at(tprov_ai, p, hdr.id, world, coord)? {
        Some(r) => r,
        None => TerritoryProvince::new(hdr.id, rule, world, coord, keep_tile, key(payer)),
    };
    let tplayer_new = tplayer_at(tplayer_ai, p, hdr.id, world, Some(&ckey))?.is_none();
    let mut pl = match tplayer_at(tplayer_ai, p, hdr.id, world, Some(&ckey))? {
        Some(r) => r,
        None => TerritoryPlayer::new(hdr.id, rule, world, ckey, tag, faction, now.ts, key(payer)),
    };
    if pl.rule != rule || tprov.rule != rule {
        return Err(BAD_ACCOUNT);
    }
    // the reach witness (T-2)
    let witness = match (x.witness, witness_ai) {
        (wix::CLAIM_TILE_WITNESS_NONE, _) => None,
        (wix::CLAIM_TILE_WITNESS_NATION_LAND, Some(w)) => {
            // a wide province that is the nation's land: a village of any
            // citizen of the nation (own or a teammate's), or a won keep
            reach_witness_distance(p, &ctx, hdr.id, world, w, faction, now_bell, coord)?;
            let wc = province_at(w, p, hdr.id)?.ok_or(BAD_ACCOUNT)?.coord;
            Some(ReachSource::NationLand(wc))
        }
        (wix::CLAIM_TILE_WITNESS_OWN, Some(w)) => {
            if w.is_writable && key(w) != key(tprov_ai) {
                return Err(BAD_ACCOUNT);
            }
            let rec = if key(w) == key(tprov_ai) {
                tprov.clone()
            } else {
                let d = w.try_borrow_data()?;
                if w.owner != p {
                    return Err(BAD_ACCOUNT);
                }
                TerritoryProvince::read(&d).map_err(territory_err)?
            };
            if rec.season_id != hdr.id || rec.world != world {
                return Err(BAD_ACCOUNT);
            }
            expect_key(w, &wtr::province_address(&ctx, rec.coord))?;
            if rec.owned_by(tag) == 0 {
                return Err(crate::CqError::OutpostRule.into());
            }
            Some(ReachSource::Own(rec.coord))
        }
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    // the distance to the claimer's nearest village (TQ-2: the first home,
    // or one of the claimer's own wide villages)
    let village_distance = match village_ai {
        None => home_coord.distance(coord),
        Some(v) => {
            let h = super::holding_at(v, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
            if h.world != world || h.owner_citizen != ckey {
                return Err(FrontierError::NotOwner.into());
            }
            expect_key(v, &wh::holding_address(&ctx, h.coord, h.site))?;
            h.coord.distance(coord).min(home_coord.distance(coord))
        }
    };
    // settle upkeep first (T-5: claims stop while unpaid), then judge
    let mut h = hold::load_touched(home, now.ts)?;
    let mut scratch_pl = pl.clone();
    settle_into(&mut scratch_pl, &mut h, now.ts, now_bell)?;
    let prm = rule.params();
    let balance = upkeep_stock(&h, now.ts, prm.cost_resource).max(0) as u64
        / permutation_rules::fixed::MILLI as u64;
    let ok: ClaimOk = wtr::judge_claim(&TileClaim {
        province: &tprov,
        tile: x.tile,
        claimer: &scratch_pl,
        home: home_coord,
        witness,
        village_distance,
        now_bell,
        balance,
    })
    .map_err(territory_err)?;
    let mut cost = [0i64; RESOURCES];
    cost[prm.cost_resource as usize] = i64::try_from(ok.cost)
        .ok()
        .and_then(|c| c.checked_mul(permutation_rules::fixed::MILLI))
        .ok_or(OVERFLOW)?;
    h.pay(now.ts, &cost).map_err(hold::holding_err)?;
    pl = scratch_pl;
    wtr::apply_claim(&mut tprov, &mut pl, x.tile, ok, now_bell).map_err(territory_err)?;
    // preflight: the bucket on a scratch Citizen; the rents
    {
        let mut scratch = cd_copy.clone();
        start.finish(&mut scratch, now.ts)?;
    }
    let rent_tp = init::rent(wtr::territory_province::SIZE)?;
    let rent_pl = init::rent(wtr::territory_player::SIZE)?;
    let need = (tprov_new as u64 * rent_tp)
        .checked_add(tplayer_new as u64 * rent_pl)
        .ok_or(OVERFLOW)?;
    if payer.lamports() < need {
        return Err(FrontierError::Insufficient.into());
    }
    let signer = SeasonSigner::new(hdr.id, hdr.bump);
    // ---- effects: the CPIs first, then byte writes ----
    if tprov_new {
        init::init_with_seed(
            payer,
            tprov_ai,
            season_ai,
            &signer,
            &wtr::province_seed(coord),
            wtr::territory_province::SIZE,
            rent_tp,
            p,
        )?;
    }
    if tplayer_new {
        init::init_with_seed(
            payer,
            tplayer_ai,
            season_ai,
            &signer,
            &wtr::player_seed(&ckey),
            wtr::territory_player::SIZE,
            rent_pl,
            p,
        )?;
    }
    tprov
        .write(&mut tprov_ai.try_borrow_mut_data()?)
        .map_err(territory_err)?;
    pl.write(&mut tplayer_ai.try_borrow_mut_data()?)
        .map_err(territory_err)?;
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        start.finish(&mut cd, now.ts)?;
        Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
    }
    write_home(home, citizen, &hh, &h, now.ts, now_bell)
}

// ------------------------------------------------------------ 0xDC op 12

/// 0xDC op 12 WideTerritorySettle (`wide_ix::TERRITORY_SETTLE`).
pub(crate) fn settle(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(Shape(wix::TERRITORY_SETTLE), a, None)?;
    let [_payer, season_ai, tplayer_ai, citizen, home] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let ckey = key(citizen);
    expect_key(tplayer_ai, &wtr::player_address(&ctx, &ckey))?;
    prologue::present(
        citizen,
        p,
        frontier_abi::layout::AccountKind::Citizen,
        hdr.id,
    )?;
    let mut pl = tplayer_at(tplayer_ai, p, hdr.id, world, Some(&ckey))?.ok_or(BAD_ACCOUNT)?;
    let cd = citizen.try_borrow_data()?.to_vec();
    // A first home that is gone (the Citizen's slot 1 no longer binds a
    // legacy village, or the canonical account is no longer that village of
    // the bound generation) pays nothing: upkeep is unpaid, so claims stop
    // and the land decays / can be conquered (verify-pr206-209: such land
    // was upkeep-free, decay- and conquest-proof forever). A wrong account
    // for a bound home is still refused.
    let home_gone = match home_ref(&cd) {
        Err(_) => true,
        Ok(hr) => {
            expect_key(home, &ctx.holding(hr.p as i32, hr.q as i32, hr.site))?;
            let hd = home.try_borrow_data()?;
            match ap::check_holding(&view(home, &hd), &ctx, hdr.id, &ckey) {
                Ok(hh) => hh.gen != hr.gen,
                Err(_) => true,
            }
        }
    };
    if home_gone {
        wtr::settle_upkeep(&mut pl, now.ts, now_bell, 0).map_err(territory_err)?;
        return pl
            .write(&mut tplayer_ai.try_borrow_mut_data()?)
            .map_err(territory_err);
    }
    let hh = check_home(home, &ctx, hdr.id, &ckey, &cd)?;
    let mut h = hold::load_touched(home, now.ts)?;
    let changed = settle_into(&mut pl, &mut h, now.ts, now_bell)?;
    pl.write(&mut tplayer_ai.try_borrow_mut_data()?)
        .map_err(territory_err)?;
    if changed {
        write_home(home, citizen, &hh, &h, now.ts, now_bell)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xDC op 13

/// 0xDC op 13 WideTerritoryDecay (`wide_ix::TERRITORY_DECAY`).
pub(crate) fn decay(p: &Pubkey, a: &[AccountInfo], x: &wix::TerritoryDecay) -> R<()> {
    check_accounts(Shape(wix::TERRITORY_DECAY), a, None)?;
    let [_payer, season_ai, tplayer_ai, tprov_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let mut pl = tplayer_at(tplayer_ai, p, hdr.id, world, None)?.ok_or(BAD_ACCOUNT)?;
    expect_key(tplayer_ai, &wtr::player_address(&ctx, &pl.citizen))?;
    // settled in this second (a WideTerritorySettle earlier in the same
    // transaction): a store that can pay now stops the decay
    if pl.paid_to != now.ts {
        return Err(FrontierError::OutOfOrder.into());
    }
    let mut tprov = {
        let d = tprov_ai.try_borrow_data()?;
        if tprov_ai.owner != p {
            return Err(BAD_ACCOUNT);
        }
        TerritoryProvince::read(&d).map_err(territory_err)?
    };
    if tprov.season_id != hdr.id || tprov.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(tprov_ai, &wtr::province_address(&ctx, tprov.coord))?;
    wtr::apply_decay(&mut tprov, &mut pl, x.tile, now_bell).map_err(territory_err)?;
    tprov
        .write(&mut tprov_ai.try_borrow_mut_data()?)
        .map_err(territory_err)?;
    pl.write(&mut tplayer_ai.try_borrow_mut_data()?)
        .map_err(territory_err)
}

// ------------------------------------------------------------ 0xDC op 14

/// 0xDC op 14 WideTerritoryConquer (`wide_ix::TERRITORY_CONQUER`).
pub(crate) fn conquer(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    check_accounts(Shape(wix::TERRITORY_CONQUER), a, None)?;
    let [payer, season_ai, province, tprov_ai, loser_ai, captor_holding, captor_citizen, captor_ai, _system] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    // the province: a territory world's, its keep taken by a recorded host
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(province, &wl::province_address(&ctx, prov.coord))?;
    let mut village_tiles = [u8::MAX; 12];
    let (rule, keep, captor) = {
        let pd = province.try_borrow_data()?;
        // the tiles with a village on them (they stay with their village)
        let r = Ro(&pd);
        let n = (r.u8(crate::layout::province::SITE_COUNT)? as usize)
            .min(permutation_rules::frontier::geometry::SITES_PER_PROVINCE);
        for (j, t) in village_tiles.iter_mut().enumerate().take(n) {
            if r.u8(crate::layout::province::site(j) + crate::layout::site::STATE)?
                == crate::layout::site::STATE_HOLDING
            {
                *t = r.u8(crate::layout::province::SITES + j)?;
            }
        }
        let keep = frontier_abi::conquest_model::read_keep(&pd)?.ok_or(FrontierError::TooEarly)?;
        let c = wl::captor_of(&pd)
            .map_err(|_| BAD_ACCOUNT)?
            .ok_or(FrontierError::TooEarly)?;
        (rule_of(&pd)?, keep, c)
    };
    // the record of the capture is the keep's current one
    if captor.keep_gen != keep.gen {
        return Err(FrontierError::TooEarly.into());
    }
    // the captor: the owner of the capturing host's home village
    let home_addr = if captor.home.ring() < FIRST_WIDE_RING {
        ctx.holding(captor.home.p() as i32, captor.home.q() as i32, captor.site)
    } else {
        wh::holding_address(&ctx, captor.home, captor.site)
    };
    expect_key(captor_holding, &home_addr)?;
    let (owner, gen) = {
        let hd = captor_holding.try_borrow_data()?;
        if captor_holding.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let r = Ro(&hd);
        (
            r.arr::<32>(crate::layout::holding::OWNER_CITIZEN)?,
            r.u8(crate::layout::holding::GEN)?,
        )
    };
    if gen != captor.gen {
        return Err(FrontierError::TooEarly.into());
    }
    expect_key(captor_citizen, &owner)?;
    prologue::present(
        captor_citizen,
        p,
        frontier_abi::layout::AccountKind::Citizen,
        hdr.id,
    )?;
    let (ctag, cfaction) = {
        let cd = captor_citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (r.u64(C::CITIZEN_TAG)?, r.u8(C::FACTION)?)
    };
    if keep.holder != cfaction {
        return Err(FrontierError::TooEarly.into());
    }
    // the records
    expect_key(tprov_ai, &wtr::province_address(&ctx, prov.coord))?;
    let mut tprov = tprov_at(tprov_ai, p, hdr.id, world, prov.coord)?.ok_or(BAD_ACCOUNT)?;
    let mut loser = tplayer_at(loser_ai, p, hdr.id, world, None)?.ok_or(BAD_ACCOUNT)?;
    expect_key(loser_ai, &wtr::player_address(&ctx, &loser.citizen))?;
    // T-8 (TQ-7, owner told 13:15, no objection): a teammate of the captor keeps its tiles
    if loser.faction == cfaction {
        return Err(FrontierError::NotEligible.into());
    }
    let ckey = key(captor_citizen);
    expect_key(captor_ai, &wtr::player_address(&ctx, &ckey))?;
    let captor_new = tplayer_at(captor_ai, p, hdr.id, world, Some(&ckey))?.is_none();
    let mut cap = match tplayer_at(captor_ai, p, hdr.id, world, Some(&ckey))? {
        Some(r) => r,
        None => TerritoryPlayer::new(
            hdr.id,
            rule,
            world,
            ckey,
            ctag,
            cfaction,
            now.ts,
            key(payer),
        ),
    };
    if loser.rule != rule || cap.rule != rule || tprov.rule != rule {
        return Err(BAD_ACCOUNT);
    }
    // both summaries settled in this second
    if loser.paid_to != now.ts || cap.paid_to != now.ts {
        return Err(FrontierError::OutOfOrder.into());
    }
    // the captor's distance: from its capturing village's province
    let to_dist = u8::try_from(captor.home.distance(prov.coord)).unwrap_or(u8::MAX);
    wtr::transfer_tiles(&mut tprov, &mut loser, &mut cap, to_dist, &village_tiles)
        .map_err(territory_err)?;
    let rent_pl = init::rent(wtr::territory_player::SIZE)?;
    if captor_new {
        if payer.lamports() < rent_pl {
            return Err(FrontierError::Insufficient.into());
        }
        init::init_with_seed(
            payer,
            captor_ai,
            season_ai,
            &SeasonSigner::new(hdr.id, hdr.bump),
            &wtr::player_seed(&ckey),
            wtr::territory_player::SIZE,
            rent_pl,
            p,
        )?;
    }
    tprov
        .write(&mut tprov_ai.try_borrow_mut_data()?)
        .map_err(territory_err)?;
    loser
        .write(&mut loser_ai.try_borrow_mut_data()?)
        .map_err(territory_err)?;
    cap.write(&mut captor_ai.try_borrow_mut_data()?)
        .map_err(territory_err)
}

// ------------------------------------------------------------ villages (T-6)

/// WideClaimSite in a territory world: the target's territory record at its
/// canonical address and the site's tile owned by the claimer
/// (`NotOwner`; an absent record owns nothing).
#[allow(clippy::too_many_arguments)]
pub(super) fn require_own_site(
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    season_id: u64,
    world: WorldId,
    coord: WideCoord,
    rec_ai: &AccountInfo,
    province: &AccountInfo,
    site: u8,
    citizen: &AccountInfo,
) -> R<()> {
    if rec_ai.is_writable {
        return Err(BAD_ACCOUNT);
    }
    expect_key(rec_ai, &wtr::province_address(ctx, coord))?;
    let rec = tprov_at(rec_ai, p, season_id, world, coord)?.ok_or(FrontierError::NotOwner)?;
    let (tile, crowded) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        let tile = r.u8(crate::layout::province::SITES + site as usize)?;
        let n = (r.u8(crate::layout::province::SITE_COUNT)? as usize)
            .min(permutation_rules::frontier::geometry::SITES_PER_PROVINCE);
        let mut sites = [(0u8, false); 12];
        for (j, s) in sites.iter_mut().enumerate().take(n) {
            *s = (
                r.u8(crate::layout::province::SITES + j)?,
                r.u8(crate::layout::province::site(j) + crate::layout::site::STATE)?
                    == crate::layout::site::STATE_HOLDING,
            );
        }
        (tile, wtr::site_crowded(site, &sites[..n]))
    };
    let tag = Ro(&citizen.try_borrow_data()?).u64(C::CITIZEN_TAG)?;
    if (tile as usize) >= rec.owner.len() || rec.owner[tile as usize] != tag {
        return Err(FrontierError::NotOwner.into());
    }
    // TQ-6 (b), owner 13:15: at least one free site between two villages
    if crowded {
        return Err(FrontierError::ReservedSite.into());
    }
    Ok(())
}

/// (test-gaps-territory) `settle_into` over the shared Q-LP17-1 (b) upkeep vectors.
#[cfg(test)]
#[path = "wide_territory_upkeep_b_tests.rs"]
mod upkeep_b_tests;
