//! Custody (workstream 10, `workstreams/10-custody/02-contract.ja.md`):
//! goods kept in another's vault, carried and used without a change of
//! owner.
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xC2 | OpenLot | [`open_lot`] |
//! | 0xC3 | SetLotQuota | [`set_lot_quota`] |
//! | 0xC4 | DepositLot | [`deposit_lot`] |
//! | 0xC5 | SetLotOrder | [`set_lot_order`] |
//! | 0xC6 | RevokeLotOrder | [`revoke_lot_order`] |
//! | 0xC7 | ShipLot | [`ship_lot`] |
//! | 0xC8 | SettleCustody | [`settle_custody`] |
//! | 0xC9 | ConsumeLot | [`consume_lot`] |
//! | 0xCA | ReconcileLot | [`reconcile_lot`] |
//! | 0xCB | CloseLot | [`close_lot`] |
//! | 0xCC | WithdrawLot | [`withdraw_lot`] |
//!
//! Every check on who signs, who owns and where the goods are is the
//! custody kernel's (`permutation_rules::frontier::custody`), called once
//! per instruction on the accounts as read; the caravan machinery (walk,
//! slots, towers, palisades, the Caravan account, settlement's resolution
//! checks) is S1's (`super::caravan`), so a custody caravan is exposed and
//! raided as any caravan is (J2 included). A custody caravan is the
//! carrier's (`OWNER_CITIZEN`, `FACTION`, the address seed) with the
//! custody mark (`CUSTODY`, `CUSTODY_OWNER_TAG`): SettleCaravan refuses
//! it, SettleCustody puts its cargo in the owner's lot.

extern crate alloc;

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::s1::{caravan as CV, place as PL, vault as VA};
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{close_key_lot, lot_loss, CqKind, EntityKind as E2, LotKey};
use frontier_abi::v2::tags::Ix as Ix2;
use frontier_abi::v2::CqError;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::caravan::{caravan_id, CARAVAN_FEE};
use permutation_rules::frontier::custody::{
    self as kc, Actor, By, CaravanSeen, CustodyError, Loss, Lot, OrderSpec, PlaceRef, ShipTo,
    VaultView, ORDER_SHIP,
};
use permutation_rules::frontier::holding::RESOURCES;

use super::caravan::{self as cvn, Owner, Place};
use super::conquest::{absent, check_accounts_v2, cq, cqlog, present_v2, season_v2, Chained2};
use super::holding::{self as hold, Player};
use crate::error::{Error, BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{citizen2 as C, province2 as P, season2 as S, Ro, Rw};
use crate::prologue::{self, expect_key, key};
use crate::{addr, FrontierError, R};

fn kind(k: CqKind) -> u8 {
    k as u8
}

/// The kernel's refusals as program codes (`02-contract.ja.md` §9).
fn cerr(e: CustodyError) -> Error {
    use CustodyError as E;
    match e {
        E::NotAuthorized => FrontierError::NotOwner.into(),
        E::WalletRequired => cq(CqError::WalletRequired),
        E::Insufficient => FrontierError::Insufficient.into(),
        E::Capacity => cq(CqError::CustodyCapacity),
        E::NoSlot => cq(CqError::CustodyNoSlot),
        E::Expired => cq(CqError::OrderExpired),
        E::Forfeited => cq(CqError::LotForfeited),
        E::NotEmpty => cq(CqError::LotNotEmpty),
        E::InTransit => cq(CqError::CaravanEarly),
        E::State => FrontierError::AlreadyDone.into(),
        E::Resource | E::Quantity | E::Order | E::Stale | E::SelfDealing | E::SeasonOver => {
            FrontierError::BadData.into()
        }
    }
}

// ------------------------------------------------------------ views

/// The kernel's view of a present, canonical Vault.
fn vault_view(p: &Pubkey, ctx: &addr::AddrCtx, sid: u64, ai: &AccountInfo) -> R<VaultView> {
    present_v2(ai, p, K2::Vault, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let (vp, vq, tile) = (r.i16(VA::P)?, r.i16(VA::Q)?, r.u8(VA::TILE)?);
    expect_key(
        ai,
        &frontier_abi::v2::addr::vault(ctx, vp as i32, vq as i32, tile),
    )?;
    let mut stores = [0i64; RESOURCES];
    let mut quota = [0i64; RESOURCES];
    for (i, (s, q)) in stores.iter_mut().zip(quota.iter_mut()).enumerate() {
        *s = r.i64(VA::store(i))?;
        *q = r.i64(VA::custody_quota(i))?;
    }
    Ok(VaultView {
        p: vp,
        q: vq,
        tile,
        gen: r.u8(VA::GEN)?,
        live: r.u8(VA::STATE)? == VA::STATE_LIVE,
        owner: r.arr(VA::OWNER_CITIZEN)?,
        owner_tag: r.u64(VA::OWNER_TAG)?,
        stores,
        cap: r.i64(VA::CAP)?,
        quota,
        lots: r.u16(VA::CUSTODY_LOTS)?,
    })
}

/// The vault at `ai` if present (canonical for the lot's tile), `None`
/// when closed.
fn vault_of_lot(
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    sid: u64,
    ai: &AccountInfo,
    lot: &Lot,
) -> R<Option<VaultView>> {
    expect_key(
        ai,
        &frontier_abi::v2::addr::vault(ctx, lot.p as i32, lot.q as i32, lot.tile),
    )?;
    if init::is_absent(ai) {
        return Ok(None);
    }
    vault_view(p, ctx, sid, ai).map(Some)
}

/// Writes what the kernel may change of a vault: stores, quota, lots.
fn put_vault(ai: &AccountInfo, v: &VaultView) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    let mut w = Rw(&mut d);
    for i in 0..RESOURCES {
        w.set_i64(VA::store(i), v.stores[i])?;
        w.set_i64(VA::custody_quota(i), v.quota[i])?;
    }
    w.set_u16(VA::CUSTODY_LOTS, v.lots)
}

fn lot_key(l: &Lot) -> LotKey {
    LotKey {
        p: l.p,
        q: l.q,
        tile: l.tile,
        gen: l.vault_gen,
        owner_tag: l.owner_tag,
        resource: l.resource,
    }
}

fn lot_address(ctx: &addr::AddrCtx, k: &LotKey) -> [u8; 32] {
    frontier_abi::v2::addr::lot(ctx, k.p, k.q, k.tile, k.gen, k.owner_tag, k.resource)
}

/// A present Lot at its canonical address.
fn lot_of(p: &Pubkey, ctx: &addr::AddrCtx, sid: u64, ai: &AccountInfo) -> R<Lot> {
    present_v2(ai, p, K2::Lot, sid)?;
    let l = Lot::decode(&ai.try_borrow_data()?).ok_or(BAD_ACCOUNT)?;
    expect_key(ai, &lot_address(ctx, &lot_key(&l)))?;
    Ok(l)
}

fn put_lot(ai: &AccountInfo, l: &Lot) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    l.encode(&mut d).ok_or(BAD_ACCOUNT)
}

fn actor(pl: &Player, citizen: &AccountInfo) -> Actor {
    Actor {
        citizen: citizen.key.to_bytes(),
        tag: pl.pc.citizen_tag,
        by_session: pl.pc.by_session,
    }
}

/// Whole units (instruction data) as milli.
fn milli(units: u32) -> R<i64> {
    (units as i64).checked_mul(MILLI).ok_or(OVERFLOW)
}

/// A vault place in the caravan form.
fn vault_place(l: &Lot) -> Place {
    Place {
        kind: PL::KIND_VAULT,
        p: l.p,
        q: l.q,
        at: l.tile,
        gen: l.vault_gen,
        tile: l.tile,
        owner: [0; 32],
    }
}

fn lot_raw(l: &Lot) -> [u8; 15] {
    lot_key(l).raw()
}

/// Emits one record chained to the lot alone.
fn emit_lot(k: CqKind, bell: u32, key: &[u8], payload: &[u8], lot: &AccountInfo) -> R<()> {
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        kind(k),
        bell,
        key,
        payload,
        &mut [Chained2 {
            entity: E2::Lot,
            data: &mut ld,
        }],
    )
}

/// LOT_LOSS (when `qty > 0`).
#[allow(clippy::too_many_arguments)]
fn emit_loss(
    l: &Lot,
    cause: Loss,
    qty: i64,
    to_tag: u64,
    caravan: (u64, u32),
    bell: u32,
    lot: &AccountInfo,
    vault: Option<&AccountInfo>,
) -> R<()> {
    if qty <= 0 {
        return Ok(());
    }
    let payload = crate::events::Buf::<29>::new()
        .u8(cause as u8)
        .i64(qty)
        .u64(to_tag)
        .u64(caravan.0)
        .u32(caravan.1);
    let key = lot_raw(l);
    match vault {
        Some(v) => {
            let mut vd = v.try_borrow_mut_data()?;
            let mut ld = lot.try_borrow_mut_data()?;
            cqlog::emit(
                kind(CqKind::LOT_LOSS),
                bell,
                &key,
                payload.get()?,
                &mut [
                    Chained2 {
                        entity: E2::Vault,
                        data: &mut vd,
                    },
                    Chained2 {
                        entity: E2::Lot,
                        data: &mut ld,
                    },
                ],
            )
        }
        None => emit_lot(CqKind::LOT_LOSS, bell, &key, payload.get()?, lot),
    }
}

// ------------------------------------------------------------ 0xC2 OpenLot

/// 0xC2 OpenLot(resource, quota): P (the vault's owner) + `[vault w]
/// [owner_citizen r] [lot w] [system]`.
pub fn open_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::OpenLot, a, None)?;
    let x = ix2::OpenLot::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, payer, season_ai, citizen, vault, owner_citizen, lot, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut v = vault_view(p, &pl.ctx, sid, vault)?;
    present_v2(owner_citizen, p, K2::Citizen, sid)?;
    let owner_tag = Ro(&owner_citizen.try_borrow_data()?).u64(C::CITIZEN_TAG)?;
    let l = kc::open(
        &mut v,
        &actor(&pl, citizen),
        (owner_citizen.key.to_bytes(), owner_tag),
        x.resource,
        milli(x.quota)?,
        pl.pc.now_bell,
        payer.key.to_bytes(),
    )
    .map_err(cerr)?;
    let k = lot_key(&l);
    expect_key(lot, &lot_address(&pl.ctx, &k))?;
    absent(lot)?;
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    let seed = frontier_abi::v2::addr::lot_seed(k.p, k.q, k.tile, k.gen, k.owner_tag, k.resource);
    let rent = init::rent(frontier_abi::v2::layout::s1::lot::SIZE)?;
    init::init_with_seed(
        payer,
        lot,
        season_ai,
        &signer,
        &seed,
        frontier_abi::v2::layout::s1::lot::SIZE,
        rent,
        p,
    )?;
    {
        let mut ld = lot.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut ld, K2::Lot, sid) {
            return Err(BAD_ACCOUNT);
        }
    }
    put_lot(lot, &l)?;
    put_vault(vault, &v)?;
    let payload = crate::events::Buf::<16>::new()
        .u64(pl.pc.citizen_tag)
        .i64(l.quota);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut vd = vault.try_borrow_mut_data()?;
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::LOT_OPENED),
        pl.pc.now_bell,
        &k.raw(),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xC3 SetLotQuota

/// 0xC3 SetLotQuota(quota): P (the vault's owner) + `[vault w] [lot w]`.
pub fn set_lot_quota(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::SetLotQuota, a, None)?;
    let x = ix2::SetLotQuota::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, _payer, _season, citizen, vault, lot] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    let mut v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?.ok_or(cq(CqError::LotForfeited))?;
    kc::set_quota(&mut v, &mut l, &actor(&pl, citizen), milli(x.quota)?).map_err(cerr)?;
    put_vault(vault, &v)?;
    put_lot(lot, &l)?;
    let payload = crate::events::Buf::<8>::new().i64(l.quota);
    let mut vd = vault.try_borrow_mut_data()?;
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        kind(CqKind::LOT_QUOTA),
        pl.pc.now_bell,
        &lot_raw(&l),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
        ],
    )
}

// ------------------------------------------------------------ caravans

/// Creates the caravan `(tag, seq)` of the signer from `src` to `dst` and
/// emits its CARAVAN_SENT (S1's send, shared with SendCaravan): returns the
/// cargo after the route's wear and the wear in bps.
#[allow(clippy::too_many_arguments)]
fn send<'a>(
    p: &Pubkey,
    pl: &Player,
    payer: &AccountInfo<'a>,
    season_ai: &AccountInfo<'a>,
    citizen: &AccountInfo<'a>,
    src_ai: &AccountInfo<'a>,
    src: &Place,
    dst: &Place,
    caravan: &AccountInfo<'a>,
    provinces: &[AccountInfo<'a>],
    seq: u32,
    steps: u8,
    path: &[u8; 12],
    fee: u64,
    cargo: &[i64; RESOURCES],
    custody: Option<(u64, u8)>,
) -> R<([i64; RESOURCES], u16)> {
    let sid = pl.pc.season.id;
    let now = pl.now.ts;
    let (cseq, faction) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        (r.u32(C::CARAVANS)?, r.u8(C::FACTION)?)
    };
    if seq != cseq || fee < CARAVAN_FEE {
        return Err(FrontierError::BadData.into());
    }
    let first = provinces.first().ok_or(FrontierError::TooManyAccounts)?;
    expect_key(first, &pl.ctx.province(src.p as i32, src.q as i32))?;
    let owner_tag = pl.pc.citizen_tag;
    let id = caravan_id(owner_tag, seq);
    let (arrive, runs, last_bell, worn) = cvn::route(
        p,
        &pl.ctx,
        sid,
        pl.pc.season.genesis_ts,
        now,
        (src.coord(), src.tile),
        (dst.coord(), dst.tile),
        steps,
        path,
        faction,
        &Owner::of(season_ai, citizen)?,
        id,
        provinces,
    )?;
    expect_key(
        caravan,
        &frontier_abi::v2::addr::caravan(&pl.ctx, owner_tag, seq),
    )?;
    let kept = cvn::worn_cargo(cargo, worn);
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    cvn::create_caravan(
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
        src,
        dst,
        steps,
        path,
        provinces,
        now,
        arrive,
        last_bell,
        &kept,
        fee,
    )?;
    if let Some((owner, resource)) = custody {
        let mut cd = caravan.try_borrow_mut_data()?;
        let mut w = Rw(&mut cd);
        w.set_u8(CV::CUSTODY, CV::CUSTODY_LOT)?;
        w.set_u8(CV::CUSTODY_RESOURCE, resource)?;
        w.set_u64(CV::CUSTODY_OWNER_TAG, owner)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        Rw(&mut cd).set_u32(C::CARAVANS, seq.checked_add(1).ok_or(OVERFLOW)?)?;
    }
    let payload = cvn::sent_payload(
        faction,
        &src.log(),
        &dst.log(),
        steps,
        &kept,
        arrive,
        &runs,
        worn,
        path,
    )?;
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut sd = src_ai.try_borrow_mut_data()?;
    let mut vd = caravan.try_borrow_mut_data()?;
    let mut pds = cvn::province_links(provinces, &runs)?;
    let mut chained: alloc::vec::Vec<Chained2> = alloc::vec::Vec::with_capacity(7);
    chained.push(Chained2 {
        entity: E2::Citizen,
        data: &mut cd,
    });
    chained.push(Chained2 {
        entity: if src.kind == PL::KIND_HOLDING {
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
        &cvn::caravan_key(owner_tag, seq),
        payload.get()?,
        &mut chained,
    )?;
    Ok((kept, worn))
}

// ------------------------------------------------------------ 0xC4 DepositLot

/// 0xC4 DepositLot(seq, qty, steps, path, fee): P (the lot's owner, by the
/// wallet) + `[src w] [vault r] [lot w] [caravan w] [system]
/// [path_province w ×1..4]`.
pub fn deposit_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(9)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::DepositLot, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::DepositLot::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, payer, season_ai, citizen, src, vault, lot, caravan, _system, provinces @ ..] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    let sid = pl.pc.season.id;
    let now = pl.now.ts;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    if l.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    let v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?.ok_or(cq(CqError::LotForfeited))?;
    // The source: the owner's own live place, its general stock.
    let s = cvn::place_of(p, &pl.ctx, sid, src)?.ok_or(FrontierError::NotFinal)?;
    if s.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    let qty = milli(x.qty)?;
    if qty <= 0 {
        return Err(FrontierError::BadData.into());
    }
    let mut cargo = [0i64; RESOURCES];
    let r = l.resource as usize;
    *cargo.get_mut(r).ok_or(BAD_ACCOUNT)? = qty;
    if s.kind == PL::KIND_HOLDING {
        let first = provinces.first().ok_or(FrontierError::TooManyAccounts)?;
        let hh = hold::owned_holding(p, &pl, src, citizen)?;
        hold::own_province_unlocked(p, &pl, &hh, first)?;
        hold::finality(&pl, &hh, src, citizen, first)?;
        let mut h = hold::load_touched(src, now)?;
        h.pay(now, &cargo).map_err(hold::holding_err)?;
        let mut hd = src.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    } else {
        // Another vault of the owner: its general stock only.
        let mut sv = vault_view(p, &pl.ctx, sid, src)?;
        if sv.stores[r] < qty {
            return Err(FrontierError::Insufficient.into());
        }
        sv.stores[r] -= qty;
        put_vault(src, &sv)?;
    }
    let seq = x.seq;
    let tag = pl.pc.citizen_tag;
    let (kept, _) = send(
        p,
        &pl,
        payer,
        season_ai,
        citizen,
        src,
        &s,
        &vault_place(&l),
        caravan,
        provinces,
        seq,
        x.steps,
        &x.path,
        x.fee,
        &cargo,
        Some((l.owner_tag, l.resource)),
    )?;
    kc::begin_inbound(&v, &mut l, (tag, seq), kept[r]).map_err(cerr)?;
    put_lot(lot, &l)?;
    let payload = crate::events::Buf::<40>::new()
        .bytes(&lot_raw(&l))
        .i64(qty)
        .i64(qty - kept[r])
        .u8(0);
    emit_lot(
        CqKind::LOT_INBOUND,
        pl.pc.now_bell,
        &cvn::caravan_key(tag, seq),
        payload.get()?,
        lot,
    )?;
    emit_loss(
        &l,
        Loss::Worn,
        qty - kept[r],
        0,
        (tag, seq),
        pl.pc.now_bell,
        lot,
        None,
    )
}

// ------------------------------------------------------------ 0xC5 SetLotOrder, 0xC6 RevokeLotOrder

/// 0xC5 SetLotOrder: P (the lot's owner, by the wallet) + `[vault r] [lot
/// w] [grantee_citizen r] [dst_vault r]` (a use order names any vault
/// there; it is not read).
pub fn set_lot_order(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::SetLotOrder, a, None)?;
    let x = ix2::SetLotOrder::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, _payer, _season, citizen, vault, lot, grantee, dst_vault] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    let v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?.ok_or(cq(CqError::LotForfeited))?;
    present_v2(grantee, p, K2::Citizen, sid)?;
    let grantee_tag = Ro(&grantee.try_borrow_data()?).u64(C::CITIZEN_TAG)?;
    let dst = PlaceRef::vault(x.dst_p, x.dst_q, x.dst_tile, x.dst_gen);
    if x.kind == ORDER_SHIP {
        // The destination stands now, of that generation.
        let dv = vault_view(p, &pl.ctx, sid, dst_vault)?;
        if !dv.live || dv.place() != dst {
            return Err(FrontierError::BadData.into());
        }
    }
    let spec = OrderSpec {
        kind: x.kind,
        grantee: grantee.key.to_bytes(),
        qty: milli(x.qty)?,
        expires_bell: x.expires_bell,
        dst,
        purpose: x.purpose,
    };
    let id = kc::set_order(
        &v,
        &mut l,
        &actor(&pl, citizen),
        x.slot,
        x.nonce,
        &spec,
        pl.pc.now_bell,
    )
    .map_err(cerr)?;
    put_lot(lot, &l)?;
    let o = l.orders.get(x.slot as usize).ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<36>::new()
        .u8(x.slot)
        .u32(id)
        .u8(o.kind)
        .u64(grantee_tag)
        .i64(o.qty_left)
        .u32(o.expires_bell)
        .bytes(&o.dst.encode())
        .u16(o.purpose);
    emit_lot(
        CqKind::LOT_ORDER,
        pl.pc.now_bell,
        &lot_raw(&l),
        payload.get()?,
        lot,
    )
}

/// 0xC6 RevokeLotOrder(slot, id): P (the lot's owner; the session key
/// may revoke) + `[lot w]`.
pub fn revoke_lot_order(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::RevokeLotOrder, a, None)?;
    let x = ix2::RevokeLotOrder::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, _payer, _season, citizen, lot] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let mut l = lot_of(p, &pl.ctx, pl.pc.season.id, lot)?;
    let released = kc::revoke_order(&mut l, &actor(&pl, citizen), x.slot, x.id, pl.pc.now_bell)
        .map_err(cerr)?;
    put_lot(lot, &l)?;
    let payload = crate::events::Buf::<13>::new()
        .u8(x.slot)
        .u32(x.id)
        .i64(released);
    emit_lot(
        CqKind::LOT_REVOKED,
        pl.pc.now_bell,
        &lot_raw(&l),
        payload.get()?,
        lot,
    )
}

// ------------------------------------------------------------ 0xC7 ShipLot, 0xCC WithdrawLot

/// LOT_SHIPPED.
#[allow(clippy::too_many_arguments)]
fn emit_shipped(
    l: &Lot,
    caravan: (u64, u32),
    sent: i64,
    worn: i64,
    to_lot: bool,
    by: By,
    carrier_tag: u64,
    bell: u32,
    lot: &AccountInfo,
) -> R<()> {
    let order_id = match by {
        By::Owner => u32::MAX,
        By::Order { id, .. } => id,
    };
    let payload = crate::events::Buf::<52>::new()
        .bytes(&lot_raw(l))
        .i64(sent)
        .i64(worn)
        .u8(to_lot as u8)
        .u32(order_id)
        .u64(carrier_tag);
    emit_lot(
        CqKind::LOT_SHIPPED,
        bell,
        &cvn::caravan_key(caravan.0, caravan.1),
        payload.get()?,
        lot,
    )
}

/// 0xC7 ShipLot: P (the owner, or a ship order's grantee; the wallet) +
/// `[vault w] [lot w] [dst_vault r] [dst_lot w] [caravan w] [system]
/// [path_province w ×1..4]`: a custody caravan of the signer from the
/// lot's vault to the owner's lot in another vault.
pub fn ship_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(10)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::ShipLot, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::ShipLot::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, payer, season_ai, citizen, vault, lot, dst_vault, dst_lot, caravan, _system, provinces @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    let v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?.ok_or(cq(CqError::LotForfeited))?;
    let mut tl = lot_of(p, &pl.ctx, sid, dst_lot)?;
    if (tl.owner_tag, tl.resource) != (l.owner_tag, l.resource) || dst_lot.key == lot.key {
        return Err(FrontierError::BadData.into());
    }
    let tv = vault_of_lot(p, &pl.ctx, sid, dst_vault, &tl)?.ok_or(cq(CqError::LotForfeited))?;
    let by = if x.slot == ix2::SHIP_BY_OWNER {
        By::Owner
    } else {
        By::Order {
            slot: x.slot,
            id: x.id,
        }
    };
    let qty = milli(x.qty)?;
    let me = actor(&pl, citizen);
    kc::spend_ship(
        &v,
        &mut l,
        &me,
        by,
        qty,
        ShipTo::Lot(tl.place()),
        pl.pc.now_bell,
    )
    .map_err(cerr)?;
    let r = l.resource as usize;
    let mut cargo = [0i64; RESOURCES];
    *cargo.get_mut(r).ok_or(BAD_ACCOUNT)? = qty;
    let (kept, _) = send(
        p,
        &pl,
        payer,
        season_ai,
        citizen,
        vault,
        &vault_place(&l),
        &vault_place(&tl),
        caravan,
        provinces,
        x.seq,
        x.steps,
        &x.path,
        x.fee,
        &cargo,
        Some((l.owner_tag, l.resource)),
    )?;
    let ck = (me.tag, x.seq);
    kc::begin_inbound(&tv, &mut tl, ck, kept[r]).map_err(cerr)?;
    put_lot(lot, &l)?;
    put_lot(dst_lot, &tl)?;
    let bell = pl.pc.now_bell;
    emit_shipped(&l, ck, qty, qty - kept[r], true, by, me.tag, bell, lot)?;
    let payload = crate::events::Buf::<40>::new()
        .bytes(&lot_raw(&tl))
        .i64(qty)
        .i64(qty - kept[r])
        .u8(1);
    emit_lot(
        CqKind::LOT_INBOUND,
        bell,
        &cvn::caravan_key(ck.0, ck.1),
        payload.get()?,
        dst_lot,
    )?;
    emit_loss(&l, Loss::Worn, qty - kept[r], 0, ck, bell, lot, None)
}

/// 0xCC WithdrawLot: P (the lot's owner; the session key may) + `[vault
/// w] [lot w] [dst r] [caravan w] [system] [path_province w ×1..4]`: an
/// ordinary caravan of the owner from the lot's vault to its own place;
/// SettleCaravan credits its general stock there.
pub fn withdraw_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(9)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::WithdrawLot, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::WithdrawLot::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, payer, season_ai, citizen, vault, lot, dst, caravan, _system, provinces @ ..] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    let v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?.ok_or(cq(CqError::LotForfeited))?;
    let t = cvn::named_place(
        p,
        &pl.ctx,
        sid,
        dst,
        (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
    )?;
    if t.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    let qty = milli(x.qty)?;
    let me = actor(&pl, citizen);
    let to = PlaceRef {
        kind: t.kind,
        p: t.p,
        q: t.q,
        at: t.at,
        gen: t.gen,
        tile: t.tile,
    };
    kc::spend_ship(
        &v,
        &mut l,
        &me,
        By::Owner,
        qty,
        ShipTo::OwnPlace(to),
        pl.pc.now_bell,
    )
    .map_err(cerr)?;
    let r = l.resource as usize;
    let mut cargo = [0i64; RESOURCES];
    *cargo.get_mut(r).ok_or(BAD_ACCOUNT)? = qty;
    let (kept, _) = send(
        p,
        &pl,
        payer,
        season_ai,
        citizen,
        vault,
        &vault_place(&l),
        &t,
        caravan,
        provinces,
        x.seq,
        x.steps,
        &x.path,
        x.fee,
        &cargo,
        None,
    )?;
    put_lot(lot, &l)?;
    let ck = (me.tag, x.seq);
    let bell = pl.pc.now_bell;
    emit_shipped(
        &l,
        ck,
        qty,
        qty - kept[r],
        false,
        By::Owner,
        me.tag,
        bell,
        lot,
    )?;
    emit_loss(&l, Loss::Worn, qty - kept[r], 0, ck, bell, lot, None)
}

// ------------------------------------------------------------ 0xC8 SettleCustody

/// 0xC8 SettleCustody(beneficiary): `[fee_payer s] [season] [caravan w]
/// [dst_vault r] [lot w] [beneficiary w] [rent_to w] [path_province r
/// ×1..4]`: after arrival, every bell resolved and no raid open, the
/// custody caravan's cargo goes to its lot; a lot whose vault was seized
/// takes nothing and the cargo is a `DestinationGone` loss (S1 §3.4). The
/// fee and the rent go as SettleCaravan's; the caravan closes.
pub fn settle_custody(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(7)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::SettleCustody, a, Some(&[1, n_prov as u8]))?;
    let x = ix2::SettleCustody::decode(d)?;
    let now = prologue::now()?;
    let [_fee_payer, season_ai, caravan, dst_vault, lot, beneficiary, rent_to, provinces @ ..] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if beneficiary.key.to_bytes() != x.beneficiary {
        return Err(BAD_ACCOUNT);
    }
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let sid = hdr.id;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let bell = hdr.bell(now.ts).unwrap_or(u32::MAX);
    let (tag, seq) = cvn::caravan_of(p, &ctx, sid, caravan)?;
    let id = caravan_id(tag, seq);
    let (dplace, cargo, fee, owner_tag, resource) = {
        let cd = caravan.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(CV::STATE)? != CV::STATE_MOVING {
            return Err(FrontierError::AlreadyDone.into());
        }
        if r.u8(CV::CUSTODY)? != CV::CUSTODY_LOT {
            return Err(BAD_ACCOUNT);
        }
        if now.ts < r.i64(CV::ARRIVE_TS)? {
            return Err(cq(CqError::CaravanEarly));
        }
        if r.arr::<32>(CV::RENT_TO)? != rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
        cvn::listed_provinces(&ctx, &cd, provinces)?;
        let res = r.u8(CV::CUSTODY_RESOURCE)?;
        if res as usize >= RESOURCES {
            return Err(BAD_ACCOUNT);
        }
        (
            Place::load(&cd, CV::DST)?,
            r.i64(CV::cargo(res as usize))?,
            r.u64(CV::FEE)?,
            r.u64(CV::CUSTODY_OWNER_TAG)?,
            res,
        )
    };
    for ai in provinces {
        present_v2(ai, p, K2::Province, sid)?;
        let pd = ai.try_borrow_data()?;
        if let Some((_, s)) = cvn::slot_of(&pd, id)? {
            if Ro(&pd).u32(P::RESOLVED_NEXT)? <= s.last_bell() {
                return Err(cq(CqError::CaravanEarly));
            }
            if s.raid_open() {
                return Err(cq(CqError::RaidState));
            }
        }
    }
    let lk = LotKey {
        p: dplace.p,
        q: dplace.q,
        tile: dplace.tile,
        gen: dplace.gen,
        owner_tag,
        resource,
    };
    expect_key(lot, &lot_address(&ctx, &lk))?;
    let mut l = lot_of(p, &ctx, sid, lot)?;
    let v = vault_of_lot(p, &ctx, sid, dst_vault, &l)?;
    let st = kc::finish_inbound(v.as_ref(), &mut l, (tag, seq), cargo).map_err(cerr)?;
    put_lot(lot, &l)?;
    {
        let mut cd = caravan.try_borrow_mut_data()?;
        Rw(&mut cd).set_u8(
            CV::STATE,
            if st.delivered > 0 || st.dest_gone == 0 {
                CV::STATE_DELIVERED
            } else {
                CV::STATE_LOST
            },
        )?;
    }
    let below = init::diverts(
        beneficiary.lamports(),
        fee,
        init::rent(beneficiary.data_len())?,
    )
    .ok_or(OVERFLOW)?;
    init::move_lamports(caravan, beneficiary, if below { 0 } else { fee })?;
    let payload = crate::events::Buf::<39>::new()
        .bytes(&lot_raw(&l))
        .i64(st.delivered)
        .i64(st.burned)
        .i64(st.dest_gone);
    emit_lot(
        CqKind::LOT_SETTLED,
        bell,
        &cvn::caravan_key(tag, seq),
        payload.get()?,
        lot,
    )?;
    emit_loss(&l, Loss::Burned, st.burned, 0, (tag, seq), bell, lot, None)?;
    let holder = v.map_or(0, |v| v.owner_tag);
    emit_loss(
        &l,
        Loss::DestinationGone,
        st.dest_gone,
        holder,
        (tag, seq),
        bell,
        lot,
        None,
    )?;
    cvn::close_caravan(p, caravan, rent_to, tag, seq, bell)
}

// ------------------------------------------------------------ 0xC9 ConsumeLot

/// 0xC9 ConsumeLot(slot, id, qty, purpose): P (a use order's grantee, by
/// the wallet) + `[vault r] [lot w]`. Workstream 9's processing calls
/// `custody::consume` in its own instruction instead.
pub fn consume_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::ConsumeLot, a, None)?;
    let x = ix2::ConsumeLot::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, _payer, _season, citizen, vault, lot] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    let v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?.ok_or(cq(CqError::LotForfeited))?;
    let qty = milli(x.qty)?;
    kc::consume(
        &v,
        &mut l,
        &actor(&pl, citizen),
        x.slot,
        x.id,
        qty,
        x.purpose,
        pl.pc.now_bell,
    )
    .map_err(cerr)?;
    put_lot(lot, &l)?;
    let payload = crate::events::Buf::<22>::new()
        .u32(x.id)
        .u64(pl.pc.citizen_tag)
        .i64(qty)
        .u16(x.purpose);
    emit_lot(
        CqKind::LOT_CONSUMED,
        pl.pc.now_bell,
        &lot_raw(&l),
        payload.get()?,
        lot,
    )
}

// ------------------------------------------------------------ 0xCA ReconcileLot

/// 0xCA ReconcileLot: `[fee_payer s] [season] [vault w] [lot w] [caravan
/// r ×0..4]`. Permissionless: (1) the lot's vault, live and of a later
/// generation, was seized: the lot is forfeited to its holder (stage 2
/// §5), logged `Seized`; (2) each listed caravan the lot expects that was
/// taken (custody mark 2) or is closed: its room is released, logged
/// `Raided` to the taker. Refused when it changes nothing.
pub fn reconcile_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_car = a
        .len()
        .checked_sub(4)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::ReconcileLot, a, Some(&[1, n_car as u8]))?;
    let _ = ix2::ReconcileLot::decode(d)?;
    let now = prologue::now()?;
    let [_fee_payer, season_ai, vault, lot, caravans @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = season_v2(season_ai, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let sid = hdr.id;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let bell = hdr.bell(now.ts).unwrap_or(u32::MAX);
    let mut l = lot_of(p, &ctx, sid, lot)?;
    let mut changed = false;
    if let Some(mut v) = vault_of_lot(p, &ctx, sid, vault, &l)? {
        if l.state == kc::LOT_OPEN && v.gen != l.vault_gen {
            let f = kc::forfeit(&mut v, &mut l).map_err(cerr)?;
            put_vault(vault, &v)?;
            put_lot(lot, &l)?;
            emit_loss(
                &l,
                Loss::Seized,
                f.qty,
                f.captor_tag,
                (0, 0),
                bell,
                lot,
                Some(vault),
            )?;
            changed = true;
        }
    }
    for ai in caravans {
        let i = l
            .inbound
            .iter()
            .position(|ib| {
                ib.live
                    && ai.key.to_bytes()
                        == frontier_abi::v2::addr::caravan(&ctx, ib.caravan_tag, ib.seq)
            })
            .ok_or(FrontierError::BadData)?;
        let ck = (l.inbound[i].caravan_tag, l.inbound[i].seq);
        let (seen, taker) = if init::is_absent(ai) {
            (CaravanSeen::Absent, 0)
        } else {
            present_v2(ai, p, K2::Caravan, sid)?;
            let cd = ai.try_borrow_data()?;
            let r = Ro(&cd);
            if r.u8(CV::CUSTODY)? == CV::CUSTODY_TAKEN {
                (CaravanSeen::Taken, r.u64(CV::TAKEN_BY_TAG)?)
            } else {
                (CaravanSeen::Custody, 0)
            }
        };
        let q = kc::drop_inbound(&mut l, ck, seen).map_err(cerr)?;
        put_lot(lot, &l)?;
        emit_loss(&l, Loss::Raided, q, taker, ck, bell, lot, None)?;
        changed = true;
    }
    if !changed {
        return Err(FrontierError::AlreadyDone.into());
    }
    let _ = lot_loss::RAIDED;
    Ok(())
}

// ------------------------------------------------------------ 0xCB CloseLot

/// 0xCB CloseLot: P + `[vault w] [lot w] [rent_to w]`: an empty lot
/// closes to its `RENT_TO`. Open: by its owner or the vault's owner (the
/// vault's quota and count are released). Forfeited: by anyone.
pub fn close_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::CloseLot, a, None)?;
    let _ = ix2::CloseLot::decode(d)?;
    let pl: Player = hold::player_as(p, a, &super::Auth::Wallet)?;
    let [_, _payer, _season, citizen, vault, lot, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let mut l = lot_of(p, &pl.ctx, sid, lot)?;
    if l.rent_to != rent_to.key.to_bytes() {
        return Err(BAD_ACCOUNT);
    }
    let mut v = vault_of_lot(p, &pl.ctx, sid, vault, &l)?;
    let open = l.state == kc::LOT_OPEN;
    kc::close(
        v.as_mut(),
        &mut l,
        Some(&actor(&pl, citizen)),
        pl.pc.now_bell,
    )
    .map_err(cerr)?;
    if open {
        put_vault(vault, v.as_ref().ok_or(BAD_ACCOUNT)?)?;
    }
    let k = lot_key(&l);
    let lamports = lot.lamports();
    let bell = pl.pc.now_bell;
    {
        let mut ld = lot.try_borrow_mut_data()?;
        let (s, head) = crate::layout::chain_of(&ld)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(s)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            &close_key_lot(&k),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            }],
        )?;
    }
    init::close_to(p, lot, rent_to, &Sink::Never, bell)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use frontier_abi::v2::log::{CqKind, CQ_SPECS};

    /// The payloads and keys the handlers write have their records' widths
    /// (the record writer refuses any other length at run time).
    #[test]
    fn custody_record_widths() {
        let width = |k: CqKind| {
            let s = CQ_SPECS.iter().find(|s| s.kind == k).expect("spec");
            (
                s.key.iter().map(|f| f.1).sum::<usize>(),
                s.payload.iter().map(|f| f.1).sum::<usize>(),
            )
        };
        // (kind, key, payload) as written in this file.
        let written = [
            (CqKind::LOT_OPENED, 15, 8 + 8),
            (CqKind::LOT_QUOTA, 15, 8),
            (CqKind::LOT_INBOUND, 12, 15 + 8 + 8 + 1),
            (CqKind::LOT_SHIPPED, 12, 15 + 8 + 8 + 1 + 4 + 8),
            (CqKind::LOT_SETTLED, 12, 15 + 8 + 8 + 8),
            (CqKind::LOT_ORDER, 15, 1 + 4 + 1 + 8 + 8 + 4 + 8 + 2),
            (CqKind::LOT_REVOKED, 15, 1 + 4 + 8),
            (CqKind::LOT_CONSUMED, 15, 4 + 8 + 8 + 2),
            (CqKind::LOT_LOSS, 15, 1 + 8 + 8 + 8 + 4),
        ];
        for (k, key, payload) in written {
            assert_eq!(width(k), (key, payload), "{k:?}");
        }
    }
}
