//! Unreferenced, read-only candidate for boundary Reveal's route stage.
//! This does not authorize admission: commitment, reveal window, latch, shield,
//! quota and receipts remain the enclosing Reveal's responsibility. No gate,
//! account writer, dispatch, cryptographic verification or CPI is added here.
use super::*;
use frontier_abi::v2::layout::{province::structure_entry as TE, AccountKind as K2};
use frontier_abi::world_index::expedition::{AccountFamily, AccountResolver};
use frontier_abi::world_index::expedition_bridge::{
    authenticate_pair, BridgeMarker, BridgeTransit, MARKER_LEN,
};
use permutation_rules::frontier::structure::{self as structures, Watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RouteCost {
    pub raw_secs: u32,
    pub watched_secs: u32,
    pub travel_secs: u32,
    pub wear_bps: u16,
}

#[derive(Clone, Copy)]
struct Land {
    key: ProvinceKey,
    passable: u64,
    rough: u64,
    road: u64,
    watch: Watch,
}

/// Derive the complete expected account order from geometry, BEFORE decoding
/// any account family. Destination first, then other first-entered provinces,
/// including origin only if a step enters one of its tiles (legacy semantics).
fn path_tiles(plain: &WidePlain, origin: TileAddress) -> R<(Vec<TileAddress>, Vec<ProvinceKey>)> {
    if plain.path_len == 0
        || plain.path_len as usize > MAX_PATH_STEPS
        || origin.key().world() != plain.dest.world()
    {
        return Err(FrontierError::Path.into());
    }
    let mut tile = WideTile::of(origin);
    let mut keys = vec![plain.dest];
    let mut steps = Vec::with_capacity(plain.path_len as usize);
    for i in 0..plain.path_len as usize {
        tile = *tile
            .neighbors()
            .get(ks::path_step(&plain.path, i) as usize)
            .and_then(|t| t.as_ref())
            .ok_or(FrontierError::Path)?;
        if !keys.contains(&tile.province()) {
            if keys.len() == MAX_PATH_PROVINCES {
                return Err(FrontierError::Path.into());
            }
            keys.push(tile.province());
        }
        steps.push(tile.address());
    }
    if tile.province() != plain.dest || tile.local() != plain.dest_tile {
        return Err(FrontierError::Path.into());
    }
    Ok((steps, keys))
}

fn land(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    key_: ProvinceKey,
    ai: &AccountInfo,
    stances: &structures::Stances,
    faction: u8,
    expelled: bool,
    bell: u32,
) -> R<Land> {
    if ai.is_writable {
        return Err(BAD_ACCOUNT);
    }
    let resolver = AccountResolver::for_season(ctx).map_err(|_| BAD_ACCOUNT)?;
    let family = resolver.family(key_).map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        ai,
        &resolver.province_address(key_).map_err(|_| BAD_ACCOUNT)?,
    )?;
    let watch = match family {
        AccountFamily::Legacy => {
            prologue::present_v2(ai, p, K2::Province, sid)?;
            let d = ai.try_borrow_data()?;
            let c = resolver
                .adapter()
                .coord_of(&key_)
                .map_err(|_| BAD_ACCOUNT)?;
            if Ro(&d).i16(PV::P)? as i32 != c.p || Ro(&d).i16(PV::Q)? as i32 != c.q {
                return Err(BAD_ACCOUNT);
            }
            // Exactly the deployed Reveal authority: standing-now structures,
            // Season stances, recorded troop faction and current Holding flag.
            super::super::structure::watch_of(&d, stances, faction, expelled)
        }
        AccountFamily::Wide => {
            let province = province_at(ai, p, sid)?.ok_or(BAD_ACCOUNT)?;
            if province.world != key_.world() || province.coord != key_.coord() {
                return Err(BAD_ACCOUNT);
            }
            let d = ai.try_borrow_data()?;
            // forts_at intentionally skips non-live records. Validate those
            // records first: opening leaves zero bytes and CloseStructure
            // clears the complete fort record. Unknown states or nonzero
            // inactive records are not evidence of an empty wide fort block.
            use frontier_abi::v2::layout::province::fort_record as FR;
            for i in 0..FR::N {
                let r = d.get(FR::at(i)..FR::at(i) + FR::SIZE).ok_or(BAD_ACCOUNT)?;
                match r[FR::STATE] {
                    FR::STATE_NONE if r.iter().all(|b| *b == 0) => {}
                    FR::STATE_LIVE => {}
                    _ => return Err(BAD_ACCOUNT),
                }
            }
            // No port of wide structures is silently implied by this route.
            // Any live or malformed structure bytes fail closed, never zeroed.
            if d.get(TE::BLOCK).ok_or(BAD_ACCOUNT)?.iter().any(|b| *b != 0)
                || !frontier_abi::clash_model::forts_at(&d, bell)?.is_empty()
            {
                return Err(FrontierError::NotImplemented.into());
            }
            Watch::default()
        }
    };
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    Ok(Land {
        key: key_,
        passable: r.u64(PV::PASSABLE_MASK)?,
        rough: r.u64(PV::ROUGH_MASK)?,
        road: r.u64(PV::ROAD_MASK)?,
        watch,
    })
}

fn walk(steps: &[TileAddress], lands: &[Land], cavalry: bool) -> R<(u32, u32)> {
    let mut raw = 0u32;
    let mut watched = 0u32;
    for tile in steps {
        let l = lands
            .iter()
            .find(|l| l.key == tile.key())
            .ok_or(FrontierError::Path)?;
        let bit = 1u64 << tile.local();
        if l.passable & !l.watch.block & bit == 0 {
            return Err(FrontierError::Path.into());
        }
        let base = if l.rough & bit != 0 {
            ROUGH_HEX_SECS
        } else {
            FLAT_HEX_SECS
        };
        let seconds = base >> (cavalry as u32 + (l.road & bit != 0) as u32);
        raw = raw.checked_add(seconds).ok_or(OVERFLOW)?;
        if l.watch.wear & bit != 0 {
            watched = watched.checked_add(seconds).ok_or(OVERFLOW)?;
        }
    }
    Ok((raw, watched))
}

/// Exact read-only boundary route inputs: authenticated original issuer and
/// paired bridge, decoded wide plaintext, and destination-first route accounts.
/// Family is derived from each expected full key; callers cannot choose a
/// shadow wide account for a legacy coordinate or supply arbitrary watch masks.
pub(super) fn inspect(
    p: &Pubkey,
    season: &AccountInfo,
    holding: &AccountInfo,
    external: &AccountInfo,
    slot: u8,
    plain: &WidePlain,
    provinces: &[AccountInfo],
) -> R<RouteCost> {
    if season.is_writable
        || holding.is_writable
        || external.is_writable
        || slot as usize >= H::TRANSIT_N
    {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let hdr = settle_season(season, p, now.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    prologue::present_v2(holding, p, K2::Holding, hdr.id)?;
    let hd = holding.try_borrow_data()?;
    let hr = Ro(&hd);
    expect_key(
        holding,
        &ctx.holding(hr.i16(H::P)? as i32, hr.i16(H::Q)? as i32, hr.u8(H::SITE)?),
    )?;
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let bridge =
        BridgeTransit::from_bytes(&ctx, &external.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
    let off = H::transit(slot as usize);
    let marker =
        BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(&ctx, &key(holding), slot, &key(external), &marker, &bridge)
        .map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    wseal::validate(plain, &t.host, t.arrive_bell).map_err(|_| FrontierError::BadPlaintext)?;
    if resolver.family(plain.dest).map_err(|_| BAD_ACCOUNT)? != AccountFamily::Wide {
        return Err(FrontierError::Path.into());
    }
    if t.dest.is_some_and(|dest| dest != plain.dest) {
        return Err(BAD_ACCOUNT);
    }
    if hdr.status == S::STATUS_ENDED && t.arrive_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let (steps, keys) = path_tiles(plain, t.origin)?;
    if provinces.len() != keys.len() {
        return Err(FrontierError::Path.into());
    }
    let stances = super::super::structure::stances_of(&season.try_borrow_data()?);
    let expelled = hr.u8(H::FLAGS)? & frontier_abi::v2::layout::player::holding::FLAG_EXPELLED != 0;
    let mut lands = Vec::with_capacity(keys.len());
    for (key_, ai) in keys.into_iter().zip(provinces) {
        lands.push(land(
            p,
            &ctx,
            hdr.id,
            key_,
            ai,
            &stances,
            t.faction,
            expelled,
            t.arrive_bell,
        )?);
    }
    let cavalry = is_cavalry(unit_from_u8(t.unit).ok_or(BAD_ACCOUNT)?);
    let (raw_secs, watched_secs) = walk(&steps, &lands, cavalry)?;
    let doctrine = of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?;
    let travel_secs = u32::try_from(doctrine.travel_secs(raw_secs as u64)).map_err(|_| OVERFLOW)?;
    check_arrival_bell(hdr.genesis_ts, t.depart_ts, travel_secs, t.arrive_bell)
        .map_err(|_| FrontierError::ArrivalBell)?;
    Ok(RouteCost {
        raw_secs,
        watched_secs,
        travel_secs,
        wear_bps: structures::wear_bps(watched_secs),
    })
}

#[cfg(test)]
#[path = "wide_expedition_route_tests.rs"]
mod tests;
