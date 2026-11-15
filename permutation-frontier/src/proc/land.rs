//! **Land preview (feature `land-preview`, opt-in, localnet only)**: the
//! program's two land instructions over the land kernel
//! (`permutation_rules::frontier::land`, "Standing Ground" in reduced form)
//! and its bytes (`frontier_abi::land_preview`). Absent from every default
//! build: no default-build code, tag, hash, budget or version changes.
//!
//! * **FoldLand** (provisional 0xCD): anyone folds the bells the Province
//!   has resolved (`resolved_next`) into the province's own land record,
//!   at most `max_bells` (≤ 8) per transaction, strictly in bell order. The
//!   record is created on the first fold (paid by the fee payer) at
//!   `ld‖hex(le16 p ‖ le16 q)` and begins at the last resolved bell, so no
//!   past bell is folded. Neighbouring provinces' land records (read only,
//!   each at its canonical address) let land grow and stay joined across
//!   province borders. The resolve itself is not touched (its budget is
//!   tight), so the land trails the resolve by one crank.
//! * **ClaimLandYield** (provisional 0xCE): anyone pays a holding the land
//!   yield of the bells folded since its last claim: its production per
//!   hour × the land bonus of its nation in its province
//!   (`land::bonus_bps`) × bells / 6, credited to its stores after the
//!   tier-aware settle. The bonus is the land as it stands when claimed.
//!
//! Numbers: [`PARAMS`] = `LandParams::PREVIEW` (6 / 72 / 36 bells, 2% a
//! tile, at most 30%). Nothing here shortens any other rule.

extern crate alloc;

use alloc::vec::Vec;

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::land_preview::{self as fl, land as LD, LandBytesError, LandHeader};
use frontier_abi::v2::layout::AccountKind as K2;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use permutation_rules::frontier::land::{self as kland, LandError, LandParams};

use super::holding::{holding_err, read_holding, settle_tiered, terrain_ore, write_holding};
use crate::error::BAD_ACCOUNT;
use crate::init::{self, SeasonSigner};
use crate::layout::{holding2 as H, province2 as P, season2 as S, site2 as SM, Ro};
use crate::prologue::{self, expect_key, key};
use crate::{addr, FrontierError, R};

/// The rule's numbers in this build.
pub const PARAMS: LandParams = LandParams::PREVIEW;

/// Routes the land tags.
pub fn dispatch(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    match d.first().copied() {
        Some(fl::TAG_FOLD_LAND) => fold(p, a, d),
        Some(fl::TAG_CLAIM_LAND_YIELD) => claim(p, a, d),
        _ => Err(FrontierError::BadData.into()),
    }
}

fn bytes_err(e: LandBytesError) -> crate::Error {
    match e {
        LandBytesError::Kernel(LandError::OutOfOrder) => FrontierError::WrongStatus.into(),
        LandBytesError::Kernel(LandError::BadInput) => FrontierError::BadData.into(),
        LandBytesError::Bad => BAD_ACCOUNT,
    }
}

/// `[fee_payer s,w] [season]` and the keeper prologue over a Running Season.
fn keeper(p: &Pubkey, a: &[AccountInfo]) -> R<(addr::AddrCtx, frontier_abi::prologue::SeasonHdr, i64)> {
    let payer = a.first().ok_or(FrontierError::TooManyAccounts)?;
    if !payer.is_signer {
        return Err(FrontierError::Auth.into());
    }
    if !payer.is_writable {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING], now.ts)?;
    let season = a.get(1).ok_or(FrontierError::TooManyAccounts)?;
    Ok((addr::ctx(&key(season), &p.to_bytes()), hdr, now.ts))
}

/// The Province (v2, this season, at its address); its `(p, q)`.
fn province_at(p: &Pubkey, ctx: &addr::AddrCtx, ai: &AccountInfo, season_id: u64) -> R<(i16, i16)> {
    prologue::present_v2(ai, p, K2::Province, season_id)?;
    let d = ai.try_borrow_data()?;
    let (pp, pq) = (Ro(&d).i16(P::P)?, Ro(&d).i16(P::Q)?);
    expect_key(ai, &ctx.province(pp as i32, pq as i32))?;
    Ok((pp, pq))
}

/// A present land record of this season at the address of its own `(p, q)`.
fn land_present(p: &Pubkey, ctx: &addr::AddrCtx, ai: &AccountInfo, season_id: u64) -> R<LandHeader> {
    if ai.owner != p || ai.data_len() != LD::SIZE {
        return Err(BAD_ACCOUNT);
    }
    let h = fl::read_header(&ai.try_borrow_data()?).map_err(bytes_err)?;
    if h.season_id != season_id {
        return Err(BAD_ACCOUNT);
    }
    expect_key(ai, &fl::land_address(ctx, h.p, h.q))?;
    Ok(h)
}

/// FoldLand: `[fee_payer s,w] [season] [province] [land w] [system]` +
/// up to six neighbouring land records; data `[tag, max_bells]`.
fn fold(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    if a.len() < fl::FOLD_FIXED || a.len() > fl::FOLD_FIXED + 6 || d.len() != 2 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let (ctx, hdr, _now) = keeper(p, a)?;
    let (season, province, land, system) = (&a[1], &a[2], &a[3], &a[4]);
    if system.key.to_bytes() != frontier_abi::prologue::ids::SYSTEM_PROGRAM {
        return Err(FrontierError::BadAddress.into());
    }
    if !land.is_writable {
        return Err(BAD_ACCOUNT);
    }
    let (pp, pq) = province_at(p, &ctx, province, hdr.id)?;
    expect_key(land, &fl::land_address(&ctx, pp, pq))?;
    let resolved_next = Ro(&province.try_borrow_data()?).u32(P::RESOLVED_NEXT)?;
    if init::is_absent(land) {
        let start = resolved_next.saturating_sub(1);
        let signer = SeasonSigner::new(hdr.id, hdr.bump);
        let rent = init::rent(LD::SIZE)?;
        init::init_with_seed(&a[0], land, season, &signer, &fl::land_seed(pp, pq), LD::SIZE, rent, p)?;
        let mut ld = land.try_borrow_mut_data()?;
        fl::write_header(&mut ld, &LandHeader { season_id: hdr.id, p: pp, q: pq, yield_bell: [start; 12] })
            .map_err(bytes_err)?;
    }
    land_present(p, &ctx, land, hdr.id)?;
    let mut next: Vec<(ProvinceCoord, Vec<u8>)> = Vec::new();
    for n in &a[fl::FOLD_FIXED..] {
        let h = land_present(p, &ctx, n, hdr.id)?;
        next.push((ProvinceCoord::new(h.p as i32, h.q as i32), n.try_borrow_data()?.to_vec()));
    }
    let next_refs: Vec<(ProvinceCoord, &[u8])> = next.iter().map(|(c, v)| (*c, v.as_slice())).collect();
    let max = d[1].clamp(1, fl::MAX_FOLD_BELLS);
    let pd = province.try_borrow_data()?;
    let heartland = fl::heartland_of(&pd);
    let mut ld = land.try_borrow_mut_data()?;
    for _ in 0..max {
        let fresh = Ro(&ld).u16(LD::VERSION)? == 0;
        let b = if fresh {
            fl::read_header(&ld).map_err(bytes_err)?.yield_bell[0]
        } else {
            fl::read_land(&ld).map_err(bytes_err)?.next_bell
        };
        if b >= resolved_next {
            break;
        }
        fl::fold_province(&pd, &mut ld, &next_refs, b, heartland, &PARAMS).map_err(bytes_err)?;
    }
    Ok(())
}

/// ClaimLandYield: `[fee_payer s,w] [season] [province] [land w] [holding w]`; data `[tag]`.
fn claim(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    if a.len() != 5 || d.len() != 1 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let (ctx, hdr, now) = keeper(p, a)?;
    let (province, land, holding) = (&a[2], &a[3], &a[4]);
    if !land.is_writable || !holding.is_writable {
        return Err(BAD_ACCOUNT);
    }
    prologue::present_v2(holding, p, K2::Holding, hdr.id)?;
    let (hp, hq, site, gen, faction) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (r.i16(H::P)?, r.i16(H::Q)?, r.u8(H::SITE)?, r.u8(H::GEN)?, r.u8(H::FACTION)?)
    };
    expect_key(holding, &ctx.holding(hp as i32, hq as i32, site))?;
    let (pp, pq) = province_at(p, &ctx, province, hdr.id)?;
    if (pp, pq) != (hp, hq) || site as usize >= P::SITES_N {
        return Err(BAD_ACCOUNT);
    }
    let pd = province.try_borrow_data()?;
    let o = P::site(site as usize);
    let r = Ro(&pd);
    if r.u8(o + SM::STATE)? != SM::STATE_HOLDING || r.u8(o + SM::GEN)? != gen || r.u8(o + SM::FACTION)? != faction {
        return Err(BAD_ACCOUNT);
    }
    let mut h = land_present(p, &ctx, land, hdr.id)?;
    if (h.p, h.q) != (pp, pq) {
        return Err(BAD_ACCOUNT);
    }
    let l = fl::read_land(&land.try_borrow_data()?).map_err(bytes_err)?;
    let paid_to = h.yield_bell[site as usize];
    let bells = l.next_bell.saturating_sub(paid_to);
    if bells == 0 {
        return Err(FrontierError::TooEarly.into());
    }
    let x = fl::province_inputs(&pd).map_err(bytes_err)?;
    let bonus = kland::bonus_bps(&l, &x.sites, faction, &PARAMS);
    {
        let mut hd = holding.try_borrow_mut_data()?;
        let ore = terrain_ore(&hd)?;
        let mut k = read_holding(&hd)?;
        settle_tiered(&mut k, now, ore)?;
        let y = fl::yield_for(k.production, bonus, bells);
        for (i, amount) in y.iter().enumerate().take(RESOURCES) {
            if *amount > 0 {
                k.credit(now, Resource::ALL[i], *amount).map_err(holding_err)?;
            }
        }
        write_holding(&mut hd, &k, now)?;
    }
    h.yield_bell[site as usize] = l.next_bell;
    fl::write_header(&mut land.try_borrow_mut_data()?, &h).map_err(bytes_err)?;
    Ok(())
}
