//! NFT resident Citizens (experimental): the resident counterpart of the
//! player prologue, the `Act` wrapper that runs any player instruction for
//! an NFT Citizen, and `Join` (the first login: one NFT, one Citizen).
//!
//! Authority is read, never stored: in the same invocation the program reads
//! the asset's current Core owner and transfer guard and the resident
//! program's holder generation and session, and compares the generation with
//! the one the actor signed (`frontier_abi::resident_auth`). The resident
//! program's `TransferResident` moves the asset, bumps the generation and
//! clears the session in one instruction, and the guard makes it the only way
//! the asset moves. So after a transfer the new holder acts at once, and the
//! previous holder, its sessions and anything signed before the transfer are
//! refused, also after a buy-back (A to B to A: generation 0, 1, 2).
//!
//! An NFT Citizen has a zero `WALLET` (`frontier_abi::resident_citizen`), so
//! every wallet path (the wallet prologue, RetireHost, CloseCitizen, the
//! transit camp settle) refuses it by address and by signer.
//!
//! Tags, the Citizen's resident fields, its address and record key follow
//! workstream 4's allocation of 2026-11-06 (provisional until integration).
//! JoinResident emits `RESIDENT_JOINED` (kind 130; 90 is S1's VAULT_BUILT),
//! keyed by the resident ID with no links; the keeper, herald, verifier and
//! fclient take it as the NFT Citizen's start.

use frontier_abi::prologue::{self as ap, SeasonHdr};
use frontier_abi::resident_citizen;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use super::Auth;
use crate::addr;
use crate::error::BAD_ACCOUNT;
use crate::layout::season as S;
use crate::prologue;
use crate::{FrontierError, R, RULESET_HASH};

/// The resident checks for `actor` acting for `citizen`, given the Season id:
/// the four proof accounts are read-only, the link, Citizen and resident
/// addresses are the asset's canonical ones, the asset carries the transfer
/// guard, the generation is current, and the actor is the owner or (when
/// `session_ok`) the owner's current session; the Citizen is that asset's NFT
/// Citizen. Returns `by_session` (the actor is a session, not the owner).
#[allow(clippy::too_many_arguments)]
pub(crate) fn check(
    p: &Pubkey,
    actor: &AccountInfo,
    citizen: &AccountInfo,
    proof: &[AccountInfo],
    generation: u32,
    now: i64,
    session_ok: bool,
    season: &Pubkey,
    season_id: u64,
) -> R<bool> {
    let [config, link, asset, resident] = proof else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if config.is_writable || link.is_writable || asset.is_writable || resident.is_writable {
        return Err(BAD_ACCOUNT);
    }
    crate::resident_binding::authorize(
        p, config, link, citizen, asset, resident, actor, generation, now, session_ok, season,
        season_id,
    )?;
    {
        let cd = citizen.try_borrow_data()?;
        if resident_citizen::resident_asset(&cd) != Some(asset.key.to_bytes()) {
            return Err(BAD_ACCOUNT);
        }
    }
    // `authorize` checked the AssetV1 layout: the owner is bytes 1..33.
    let data = asset.try_borrow_data()?;
    Ok(data.get(1..33).ok_or(BAD_ACCOUNT)? != actor.key.as_ref())
}

/// Steps 1 and 2 of the player prologue for an NFT Citizen, over the
/// instruction's own accounts `a = [actor, payer, season, citizen, ..]`: the
/// signatures and writability the wallet prologue checks, the Season (PDA,
/// status Running, ruleset), then [`check`]. Steps 3 and 4 follow in
/// `PlayerStart::finish`, as for a wallet Citizen.
pub(crate) fn start(
    p: &Pubkey,
    a: &[AccountInfo],
    proof: &[AccountInfo],
    generation: u32,
    session_ok: bool,
    now: i64,
) -> R<ap::PlayerStart> {
    let hdr = season_running(p, a, now)?;
    let [actor, _, season, citizen, ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let by_session = check(
        p, actor, citizen, proof, generation, now, session_ok, season.key, hdr.id,
    )?;
    Ok(ap::PlayerStart {
        season: hdr,
        by_session,
        citizen_tag: addr::citizen_tag(citizen.key.as_array()),
    })
}

/// The wallet prologue's account checks (signers, writability) and the
/// Season, Running.
fn season_running(p: &Pubkey, a: &[AccountInfo], now: i64) -> R<SeasonHdr> {
    let [actor, payer, season, citizen, ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if !actor.is_signer || !payer.is_signer {
        return Err(FrontierError::Auth.into());
    }
    if !payer.is_writable || !citizen.is_writable {
        return Err(BAD_ACCOUNT);
    }
    prologue::season(season, p, Some(&RULESET_HASH), &[S::STATUS_RUNNING], now)
}

/// The canonical address check of a Citizen account whose data is `cd`, for
/// paths that name a Citizen without its actor (the keeper's settles, the
/// close): the Citizen is at `citizen_by_tag15` of its record key, the wallet
/// tag for a wallet Citizen (exactly the check these paths made before) and
/// the resident id for an NFT resident's Citizen (`BadAddress` otherwise). A
/// Citizen flagged as an NFT Citizen but not a valid one is refused.
pub(crate) fn expect_citizen_address(
    ctx: &crate::addr::AddrCtx,
    ai: &AccountInfo,
    cd: &[u8],
) -> R<()> {
    let tag15 = resident_citizen::record_tag15(cd).ok_or(BAD_ACCOUNT)?;
    prologue::expect_key(ai, &ctx.citizen_by_tag15(&tag15))
}

/// The resident proof of `auth`, or `None` for a wallet Citizen.
pub(crate) fn proof_of<'a, 'b>(auth: &Auth<'a, 'b>) -> Option<(&'a [AccountInfo<'b>], u32)> {
    match auth {
        Auth::Wallet => None,
        Auth::Resident { proof, generation } => Some((proof, *generation)),
    }
}

/// `ResidentAct` (experimental): run the player instruction `inner` for an NFT
/// resident's Citizen. `accounts` is that instruction's own account list
/// followed by the four proof accounts `[policy, link, asset, resident]`.
/// Every instruction that runs the player prologue is reachable (27); any
/// other inner tag is refused (`BadData`). SetSession is refused inside
/// (`Auth`): an NFT Citizen's session is the resident program's.
#[cfg(feature = "nft-experimental")]
pub(crate) fn act(p: &Pubkey, accounts: &[AccountInfo], generation: u32, inner: &[u8]) -> R<()> {
    use super::{caravan, citizen, conquest, holding, host, nation, structure};
    use frontier_abi::v2::Ix;
    let n = accounts.len();
    if n < 8 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let (a, proof) = accounts.split_at(n - 4);
    let auth = Auth::Resident { proof, generation };
    let au = &auth;
    match frontier_abi::v2::ix::tag_of(inner)? {
        Ix::Harvest => holding::harvest_as(p, a, inner, au),
        Ix::Build => holding::build_as(p, a, inner, au),
        Ix::Train => holding::train_as(p, a, inner, au),
        Ix::Explore => holding::explore_as(p, a, inner, au),
        Ix::Muster => host::muster_as(p, a, inner, au),
        Ix::Dissolve => host::dissolve_as(p, a, inner, au),
        Ix::Garrison => host::garrison_as(p, a, inner, au),
        Ix::Depart => host::depart_as(p, a, inner, au),
        Ix::BuildStructure => structure::build_structure_as(p, a, inner, au),
        Ix::SeizeStructure => structure::seize_structure_as(p, a, inner, au),
        Ix::CloseStructure => structure::close_structure_as(p, a, inner, au),
        Ix::FortGarrison => structure::fort_garrison_as(p, a, inner, au),
        Ix::Propose => nation::propose_as(p, a, inner, au),
        Ix::Vote => nation::vote_as(p, a, inner, au),
        Ix::BuildVault => caravan::build_vault_as(p, a, inner, au),
        Ix::SendCaravan => caravan::send_caravan_as(p, a, inner, au),
        Ix::RaidCaravan => caravan::raid_caravan_as(p, a, inner, au),
        Ix::RaidDomestic => caravan::raid_domestic_as(p, a, inner, au),
        Ix::SeizeVault => caravan::seize_vault_as(p, a, inner, au),
        Ix::CloseVault => caravan::close_vault_as(p, a, inner, au),
        Ix::SetSession => citizen::set_session_as(p, a, inner, au),
        Ix::SetVigil => citizen::set_vigil_as(p, a, inner, au),
        Ix::FileOutpost => citizen::file_outpost_as(p, a, inner, au),
        Ix::FileTicket => citizen::file_ticket_as(p, a, inner, au),
        Ix::PlaceHome => citizen::place_home_as(p, a, inner, au),
        Ix::DeclareSiege => conquest::declare_siege_as(p, a, inner, au),
        Ix::RetireHost => conquest::retire_host_as(p, a, inner, au),
        _ => Err(FrontierError::BadData.into()),
    }
}

/// `JoinResident` (experimental): the first login of an NFT resident. Accounts:
/// `[owner s] [payer s w] [season] [frontier] [citizen w] [system] [policy]
/// [link w] [asset] [resident] [join_gate s?]`. As the wallet Join (§5.9):
/// Running and `bell < join_close_bell` (`WrongStatus`), the Season's join
/// gate when it has one (`JoinGate`), `faction ≤ 5` (`BadData`), capacity on
/// the folded Frontier (`Capacity`). Then the link and the Citizen at the
/// asset's addresses (`resident_binding::join_accounts`: one NFT, one
/// Citizen; the owner itself, not a session, at the signed generation, the
/// asset guarded); the Citizen is created from the Season at
/// `citizen_by_tag15(resident id)` exactly as the wallet Join creates one at
/// `citizen_by_tag15(wallet tag)`. The Citizen is written as the wallet Join writes it, with
/// a zero `WALLET`, no Frontier session, and its resident fields
/// (`frontier_abi::resident_citizen::mark`).
///
/// Not yet: the `RESIDENT_JOINED` record (kind 90, allocated; it needs the
/// readers in the same change) and the JoinShard count (counting without the
/// record would break the shard's record chain for wallet players). The
/// shard index is derived from the asset as the wallet Join derives it from
/// the wallet.
#[cfg(feature = "nft-experimental")]
pub(crate) fn join(p: &Pubkey, accounts: &[AccountInfo], generation: u32, faction: u8) -> R<()> {
    use crate::layout::{citizen as C, frontier as FR, init_header, join_shard as JS};
    use crate::layout::{AccountKind, Ro, Rw};
    let (owner, payer, season_ai, frontier, citizen, system, proof, gate) = match accounts {
        [o, pa, s, f, c, sys, rest @ ..] if rest.len() == 4 => (o, pa, s, f, c, sys, rest, None),
        [o, pa, s, f, c, sys, rest @ ..] if rest.len() == 5 => {
            (o, pa, s, f, c, sys, &rest[..4], Some(&rest[4]))
        }
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    let [config, link, asset, resident] = proof else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if *system.key != crate::init::SYSTEM || !owner.is_signer {
        return Err(FrontierError::Auth.into());
    }
    if !payer.is_signer
        || !payer.is_writable
        || config.is_writable
        || asset.is_writable
        || resident.is_writable
        || frontier.is_writable
    {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING],
        now.ts,
    )?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if now_bell >= hdr.join_close_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let (join_gate, reserve_bps, r_max) = {
        let sd = season_ai.try_borrow_data()?;
        let r = Ro(&sd);
        (
            r.arr::<32>(S::JOIN_GATE)?,
            r.u16(S::RESERVE_BPS)?,
            r.u16(S::R_MAX)?.max(
                frontier_abi::v2::presets::ConquestParams::of_season(&sd)
                    .map_or(0, |c| c.r_max_ceiling),
            ),
        )
    };
    match gate {
        None if join_gate != [0u8; 32] => return Err(FrontierError::JoinGate.into()),
        Some(_) if join_gate == [0u8; 32] => return Err(FrontierError::TooManyAccounts.into()),
        Some(g) if g.key.to_bytes() != join_gate || !g.is_signer => {
            return Err(FrontierError::JoinGate.into())
        }
        _ => {}
    }
    if faction >= JS::FACTIONS {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&prologue::key(season_ai), &p.to_bytes());
    super::map::present_at(frontier, &ctx.frontier(), p, AccountKind::Frontier, hdr.id)?;
    {
        let fd = frontier.try_borrow_data()?;
        let r = Ro(&fd);
        let open = r.u32(FR::OPEN_SITES)? as u64;
        let occupied = r.u32(FR::OCCUPIED_SITES)? as u64;
        let rings = r.u16(FR::RINGS_OPENED)?;
        let r_max = r_max.max(r.u16(FR::R_MAX_EXT)?);
        if !super::map::join_capacity_available(open, occupied, reserve_bps, rings, r_max) {
            return Err(FrontierError::Capacity.into());
        }
    }
    crate::resident_binding::join_accounts(
        p,
        config,
        payer,
        link,
        citizen,
        asset,
        resident,
        owner,
        generation,
        now.ts,
        season_ai.key,
    )?;
    let asset_bytes = asset.key.to_bytes();
    let tag15 = resident_citizen::resident_tag15(&asset_bytes);
    // The Citizen at its Season's citizen_by_tag15(resident id), created as
    // the wallet Join creates one at citizen_by_tag15(wallet tag).
    crate::init::init_with_seed(
        payer,
        citizen,
        season_ai,
        &crate::init::SeasonSigner::new(hdr.id, hdr.bump),
        &frontier_abi::addr::citizen_seed(&tag15),
        C::SIZE,
        crate::init::rent(C::SIZE)?,
        p,
    )?;
    let bucket_t = u32::try_from(now.ts.saturating_sub(hdr.genesis_ts).max(0))
        .map_err(|_| FrontierError::Overflow)?;
    let mut cd = citizen.try_borrow_mut_data()?;
    init_header(&mut cd, AccountKind::Citizen, hdr.id)?;
    {
        let mut w = Rw(&mut cd);
        w.set_u8(C::FACTION, faction)?;
        w.set_u8(C::FLAGS, C::FLAG_JOINED)?;
        w.set_u8(C::EXPLORES_FLOOR_LEFT, C::EXPLORES_FLOOR)?;
        w.set_u32(C::JOIN_BELL, now_bell)?;
        w.set_u8(C::JOIN_SHARD, addr::join_shard_of(&asset_bytes))?;
        w.set_u32(C::BUCKET_MILLI, hdr.bucket_burst as u32 * 1_000)?;
        w.set_u32(C::BUCKET_T, bucket_t)?;
        w.set_u32(C::TICKET_BELL, C::NO_TICKET)?;
        w.set_u64(C::CITIZEN_TAG, addr::citizen_tag(citizen.key.as_array()))?;
        w.set_i64(C::LAST_ACTION_TS, now.ts)?;
        w.set_arr(C::RENT_PAYER, payer.key.as_ref())?;
    }
    // MC §5.2.3: the slot-indexed holding list starts empty (gen 0xFF).
    for slot in 1..=3 {
        super::citizen::clear_holding_ref(&mut cd, slot)?;
    }
    if !resident_citizen::mark(&mut cd, &asset_bytes) {
        return Err(BAD_ACCOUNT);
    }
    // RESIDENT_JOINED (kind 130, workstream 4's allocation): the Citizen's
    // start for the readers, keyed by the resident ID, with no links.
    let payload = crate::events::Buf::<42>::new()
        .bytes(&asset_bytes)
        .u8(faction)
        .u8(addr::join_shard_of(&asset_bytes))
        .u32(generation)
        .u32(now_bell);
    crate::events::emit_cq(
        frontier_abi::v2::log::CqKind::RESIDENT_JOINED,
        now_bell,
        &tag15,
        payload.get()?,
        &mut [],
    )
}

#[cfg(test)]
mod act_list {
    // Text only: no account, key, address or signature is made.
    #[test]
    fn act_runs_exactly_the_abi_list_and_refuses_set_session() {
        let src = include_str!("resident.rs");
        let body =
            &src[src.find("pub(crate) fn act(").unwrap()..src.find("pub(crate) fn join(").unwrap()];
        let arms: Vec<&str> = body
            .lines()
            .filter_map(|l| l.trim().strip_prefix("Ix::"))
            .filter_map(|l| l.split_whitespace().next())
            .collect();
        let mut want: Vec<String> = frontier_abi::resident_wire::ACT_RUNS
            .iter()
            .map(|ix| format!("{ix:?}"))
            .collect();
        want.push("SetSession".into());
        let mut got: Vec<String> = arms.iter().map(|s| s.to_string()).collect();
        want.sort();
        got.sort();
        assert_eq!(got, want);
    }
}
