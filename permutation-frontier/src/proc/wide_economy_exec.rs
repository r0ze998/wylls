//! **Experimental** (`wide-world-experimental`), phase B of the host-only
//! wide economy (2026-11-08): the **authenticated execution** of a wide
//! Harvest, Build or Train — 0xDA op 3, `wide_ix::Economy` — as a private
//! child of `proc::wide`, so it reuses that module's player prologue
//! (`player_start_as`), canonical wide loaders (`holding_at`,
//! `province_at`, `world_of`) and account shapes without publishing them.
//!
//! **What runs, in order.**
//!
//! 1. The account table the **decoded action** selects (`ECONOMY`, or
//!    `ECONOMY_MIRROR` for walls and the tier-up, whose province is
//!    writable): exactly six accounts, signers and writability
//!    (`check_accounts`). The clock (`prologue::now`).
//! 2. The deployed player prologue through `player_start_as`: the wallet
//!    or its unexpired session, or an NFT resident's current Core owner or
//!    session at the signed holder generation (read-only proof accounts);
//!    the Season at its recomputed PDA, Running, this ruleset, this
//!    build's wide program version. Nothing is written yet
//!    (`PlayerStart::finish` is deferred to a copy, below).
//! 3. The wide holding at its canonical address, program-owned, of this
//!    Season and of the Season's one derived world, the Citizen's
//!    (`NotOwner`); its own wide province at its canonical address, of the
//!    same season, world and coordinate; the Citizen's slot bound to a wide
//!    holding (`wh::binding_of == Wide`, else `TicketState`); the prefix
//!    `order` equal to the slot.
//! 4. **Copies** of the Season, Citizen, holding and province bytes as
//!    read. `PlayerStart::finish` (the bucket, the end bell) runs **once**,
//!    on the Citizen copy, and the owner-action stamp (`LAST_ACTION_TS`)
//!    is set there. The live Citizen is never passed to `finish`.
//! 5. The S1 body: `proc::wide_economy::preview` over the holding and
//!    province copies, under pins **derived here** from the authenticated
//!    records (never from the caller) and the real clock. The preview's own
//!    checks (live state, the capture lock, the site mirror, the lazy
//!    finality flip, the exact S1 economics) run there; a refusal is the
//!    handler's refusal. The preview is consumed only here, after every
//!    check above; a preview computed by anyone else is never applied.
//! 6. The receipt (`world_index::economy`): the input digest over the
//!    complete Season, Citizen, holding and province bytes **as read**, the
//!    output digest over the Citizen copy after `finish` and the staged
//!    holding and province (normalized); exactly one `Economy` or
//!    `EconomyMirror` record carrying the lazy-finality bit, chained to the
//!    holding (and, for a mirror write, the province) on the **staged**
//!    copies: every link, the tail and a sequence overflow are decided
//!    before any live write.
//! 7. The writes: every mutable borrow is taken together, every length is
//!    checked against its staged image, and only then are the images
//!    copied into the Citizen, the holding and — for walls and the tier-up
//!    only — the province. No fallible step follows the first copy. The
//!    borrows are released, then the prepared `PSW1` record is logged.
//!
//! For every other action the province stays **byte-identical**, chain
//! header included, whether the caller listed it readable or writable. No
//! lamport moves, no CPI, no deployed `PS2` record: the Citizen's own PS2
//! chain is untouched (its complete pre- and post-state enter the receipt's
//! digests by content). No economic constant, actor permission, live
//! registry, Deploy ban, Depart gate, UI send, host identity, transit,
//! escrow or rent rule is changed here. `proc::wide::emit_wide` is **not**
//! used: it logs as it writes, and this handler logs only after the last
//! write.

use alloc::vec::Vec;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::world_index::economy::{self as weco, Action, EconomyError, EconomyReceipt};
use frontier_abi::world_index::event::{self as wev, WideEntity, WideLink};
use frontier_abi::world_index::holding::{self as wh, HoldingError, SlotBinding};
use frontier_abi::world_index::land as wl;
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::{ProvinceKey, WideHostRef};

use crate::addr;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::layout::{chain_of, citizen as C, holding as H, set_chain, Ro, Rw};
use crate::proc::wide_economy::{self as pre, Clock, Pins};
use crate::proc::Auth;
use crate::prologue::{self, check_accounts, expect_key, key};
use crate::{FrontierError, R};

use super::{holding_at, holding_err, player_start_as, province_at, world_of, Shape};

/// WideEconomy (0xDA, op 3) under `auth` (module doc): the wallet form
/// from `dispatch`, the NFT resident form from `resident_act`.
pub(super) fn economy_as(p: &Pubkey, a: &[AccountInfo], x: &wix::Economy, auth: &Auth) -> R<()> {
    let action = x.action;
    // The wire decoder never yields an out-of-range action; a hand-built
    // one is refused here before it selects a table.
    if !action.is_valid() {
        return Err(FrontierError::BadData.into());
    }
    let mirror = action.mirror_write();
    // 1. the table of the decoded action, exactly six accounts.
    check_accounts(Shape(wix::WideCommand::Economy(*x).accounts()), a, None)?;
    let [_actor, _payer, season_ai, citizen, holding, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    // 2. the player prologue (wallet or NFT resident), this build's Season.
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    // 3. the holding and its own province, canonical and the Citizen's.
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    if h.owner_citizen != key(citizen) {
        return Err(FrontierError::NotOwner.into());
    }
    expect_key(province, &wl::province_address(&ctx, h.coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != h.coord {
        return Err(BAD_ACCOUNT);
    }
    // Three distinct accounts are written or read as distinct: the
    // canonical addresses differ by construction; a list that aliases one
    // position to another is refused before any borrow is taken for writing.
    if key(citizen) == key(holding)
        || key(citizen) == key(province)
        || key(holding) == key(province)
    {
        return Err(BAD_ACCOUNT);
    }
    {
        let cd = citizen.try_borrow_data()?;
        match wh::binding_of(&cd, h.slot).map_err(holding_err)? {
            SlotBinding::Wide => {}
            _ => return Err(holding_err(HoldingError::NotWideBound(h.slot))),
        }
    }
    // 4. the complete input state, copied; the Citizen's bucket and the end
    //    bell on the copy alone.
    let season_in: Vec<u8> = season_ai.try_borrow_data()?.to_vec();
    let citizen_in: Vec<u8> = citizen.try_borrow_data()?.to_vec();
    let holding_in: Vec<u8> = holding.try_borrow_data()?.to_vec();
    let province_in: Vec<u8> = province.try_borrow_data()?.to_vec();
    if Ro(&holding_in).u8(H::ORDER)? != h.slot {
        return Err(BAD_ACCOUNT);
    }
    let mut citizen_out = citizen_in.clone();
    start.finish(&mut citizen_out, now.ts)?;
    Rw(&mut citizen_out).set_i64(C::LAST_ACTION_TS, now.ts)?;
    // 5. the S1 body on copies, under pins derived from the authenticated
    //    records and the real clock.
    let pins = Pins {
        season_id: hdr.id,
        world,
        coord: h.coord,
        site: h.site,
        gen: h.gen,
        slot: h.slot,
        owner_citizen: h.owner_citizen,
    };
    let clock = Clock {
        genesis_ts: hdr.genesis_ts,
        now_ts: now.ts,
    };
    let staged = pre::preview(
        &holding_in,
        &province_in,
        &pins,
        &clock,
        preview_action(action),
    )?;
    if staged.now_bell != now_bell || staged.province.is_some() != mirror {
        return Err(BAD_ACCOUNT);
    }
    let mut holding_out = staged.holding;
    let mut province_out = match staged.province {
        Some(pd) => pd,
        None => province_in.clone(),
    };
    // 6. the receipt and its record, every chain advanced on the staged
    //    copies before any live write.
    let pkey = ProvinceKey::new(world, h.coord);
    let href = WideHostRef::new(pkey, h.site, h.gen, 0).map_err(|_| BAD_ACCOUNT)?;
    let input_digest = weco::input_digest(
        &href,
        action,
        now.ts,
        &season_in,
        &weco::Snapshots {
            citizen: &citizen_in,
            holding: &holding_in,
            province: &province_in,
        },
    )
    .map_err(economy_err)?;
    let output_digest = weco::output_digest(
        &href,
        action,
        now.ts,
        staged.became_final,
        &weco::Snapshots {
            citizen: &citizen_out,
            holding: &holding_out,
            province: &province_out,
        },
    )
    .map_err(economy_err)?;
    let receipt = EconomyReceipt {
        action,
        now_ts: now.ts,
        became_final: staged.became_final,
        input_digest,
        output_digest,
    };
    let kind = receipt.kind();
    let payload = receipt.to_bytes().ok_or(BAD_ACCOUNT)?;
    let ekey = weco::economy_key(&href).map_err(economy_err)?;
    let mut body = [0u8; wev::MAX_BODY];
    let n = wev::write_body(kind, now_bell, &ekey, &payload, &mut body).ok_or(BAD_ACCOUNT)?;
    let mut links: Vec<WideLink> = Vec::with_capacity(wev::MAX_LINKS);
    for entity in kind.links() {
        let data: &mut Vec<u8> = match entity {
            WideEntity::Province => &mut province_out,
            WideEntity::Holding => &mut holding_out,
        };
        let (seq, head) = chain_of(data.as_slice())?;
        let link = wev::advance(*entity, seq, &head, &body[..n]).ok_or(OVERFLOW)?;
        set_chain(data.as_mut_slice(), link.seq, &link.head)?;
        links.push(link);
    }
    let m = wev::write_tail(kind, &links, &mut body, n).ok_or(BAD_ACCOUNT)?;
    if !mirror && province_out != province_in {
        return Err(BAD_ACCOUNT);
    }
    // 7. the writes: every borrow together, every length exact, then the
    //    copies; nothing fallible after the first copy.
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let mut hd = holding.try_borrow_mut_data()?;
        let mut pd = if mirror {
            Some(province.try_borrow_mut_data()?)
        } else {
            None
        };
        if cd.len() != citizen_out.len()
            || hd.len() != holding_out.len()
            || pd.as_ref().is_some_and(|d| d.len() != province_out.len())
        {
            return Err(BAD_ACCOUNT);
        }
        cd.copy_from_slice(&citizen_out);
        hd.copy_from_slice(&holding_out);
        if let Some(pd) = pd.as_mut() {
            pd.copy_from_slice(&province_out);
        }
    }
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &body[..m]]);
    Ok(())
}

/// The wire action as the preview names it (the same three bodies; the
/// ranges were checked by the wire decoder and `Action::is_valid`).
fn preview_action(a: Action) -> pre::Action {
    match a {
        Action::Harvest => pre::Action::Harvest,
        Action::Build { item } => pre::Action::Build { item },
        Action::Train { unit, n } => pre::Action::Train { unit, n },
    }
}

/// A receipt-codec refusal as a program code: an action outside the
/// canonical ranges is bad data; a snapshot that does not read or is not
/// the reference's is a bad account (the loaders above make both
/// unreachable for authenticated inputs).
fn economy_err(e: EconomyError) -> crate::Error {
    match e {
        EconomyError::Tag(_)
        | EconomyError::Padding
        | EconomyError::Item(_)
        | EconomyError::Unit(_)
        | EconomyError::Count => FrontierError::BadData.into(),
        _ => BAD_ACCOUNT,
    }
}
