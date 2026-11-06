//! Experimental program-side checks for one NFT / one Citizen.
//!
//! `authorize` is called by `proc::resident` for every NFT Citizen's player
//! instruction; `join_accounts` by `JoinResident`; `create_policy` by
//! `CreateResidentPolicy`. Legacy migration is NOT implemented here. Callers must obtain `season_id` from trusted program-owned
//! world configuration, `now` from the runtime clock, and `generation` from
//! signed instruction data, never untrusted substitutions. The configuration
//! account creation helper below has not been exercised in a runtime test.
//! The link and the policy are global to this Frontier program; the NFT
//! Citizen is per Season, at `citizen_by_tag15(resident id)`. The link binds
//! the asset to its resident account once, for every Season; the Citizen it
//! names is the first one (history). A Season's NFT Citizen is checked by its
//! canonical address, its presence in that Season and its own resident mark
//! (the asset), not by the link's first Citizen — so the same NFT can join a
//! later Season (2026-11-06 candidate, workstream 04 for 20's U45).

use frontier_abi::{resident_auth, resident_binding, resident_policy};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

const LINK_SEED: &[u8] = b"nft-citizen-link";
const RESIDENT_SEED: &[u8] = b"resident";
const POLICY_SEED: &[u8] = b"nft-resident-policy";
/// The resident program's collection-authority seed (permutation-nft-resident-spike/program).
const GUARD_SEED: &[u8] = b"collection-authority";

/// Only a canonical, program-owned, initialized policy is accepted. The
/// policy is still experimental: no instruction calls its creation helper,
/// and integration must preserve its write-once invariant.
fn read_policy(
    program: &Pubkey,
    config: &AccountInfo<'_>,
) -> Result<resident_auth::Policy, ProgramError> {
    let expected = Pubkey::find_program_address(&[POLICY_SEED], program).0;
    if config.key != &expected || config.owner != program {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = config.try_borrow_data()?;
    resident_policy::read(&data).ok_or(ProgramError::InvalidAccountData)
}

/// Create the global write-once policy with the program's actual LoaderV3
/// upgrade authority. The payer is that signer. No instruction dispatches to
/// this helper yet. Immutable programs (no upgrade authority) are refused.
pub fn create_policy<'a>(
    program: &Pubkey,
    authority: &AccountInfo<'a>,
    config: &AccountInfo<'a>,
    program_account: &AccountInfo<'a>,
    programdata: &AccountInfo<'a>,
    policy: &resident_auth::Policy,
) -> crate::R<()> {
    if !authority.is_signer
        || crate::proc::season::upgrade_authority(program, program_account, programdata)?
            != authority.key.to_bytes()
    {
        return Err(crate::FrontierError::Auth.into());
    }
    // The guard authority must be the resident program's collection-authority
    // address: the only authority whose permanent delegates make every change
    // of holder go through TransferResident (frontier_abi::resident_guard).
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (guard, _) = Pubkey::find_program_address(&[GUARD_SEED], &resident_program);
    if guard.to_bytes() != policy.guard_authority {
        return Err(crate::FrontierError::BadData.into());
    }
    let mut encoded = [0u8; resident_policy::LEN];
    if !resident_policy::write_once(&mut encoded, policy) {
        return Err(crate::FrontierError::BadData.into());
    }
    crate::init::init_nft_pda(
        authority,
        config,
        &[POLICY_SEED],
        resident_policy::LEN,
        program,
    )?;
    let mut data = config.try_borrow_mut_data()?;
    if data.len() != encoded.len() || data.iter().any(|&b| b != 0) {
        return Err(crate::error::BAD_ACCOUNT);
    }
    data.copy_from_slice(&encoded);
    Ok(())
}

fn canonical(
    program: &Pubkey,
    resident_program: &Pubkey,
    asset: &Pubkey,
    season: &Pubkey,
) -> (Pubkey, Pubkey, Pubkey) {
    let link = Pubkey::find_program_address(&[LINK_SEED, asset.as_ref()], program).0;
    // The NFT Citizen lives where a wallet Citizen would, keyed by the
    // resident id instead of the wallet tag (ABI allocation §5).
    let tag15 = frontier_abi::resident_citizen::resident_tag15(&asset.to_bytes());
    let citizen = Pubkey::new_from_array(
        crate::addr::ctx(&season.to_bytes(), &program.to_bytes()).citizen_by_tag15(&tag15),
    );
    let resident =
        Pubkey::find_program_address(&[RESIDENT_SEED, asset.as_ref()], resident_program).0;
    (link, citizen, resident)
}

/// Refuse any noncanonical account even if its data looks like a valid link.
#[allow(clippy::too_many_arguments)]
fn check_addresses(
    program: &Pubkey,
    policy: &resident_auth::Policy,
    link: &AccountInfo<'_>,
    citizen: &AccountInfo<'_>,
    asset: &AccountInfo<'_>,
    resident: &AccountInfo<'_>,
    season: &Pubkey,
    season_id: u64,
) -> Result<(), ProgramError> {
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (expected_link, expected_citizen, expected_resident) =
        canonical(program, &resident_program, asset.key, season);
    if link.key != &expected_link
        || citizen.key != &expected_citizen
        || resident.key != &expected_resident
        || link.owner != program
    {
        return Err(ProgramError::InvalidAccountData);
    }
    // Citizen data belongs to the authenticated Frontier program and season.
    crate::prologue::present_v2(
        citizen,
        program,
        frontier_abi::v2::layout::AccountKind::Citizen,
        season_id,
    )
    .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn check_actor(
    policy: &resident_auth::Policy,
    asset: &AccountInfo<'_>,
    resident: &AccountInfo<'_>,
    actor: &AccountInfo<'_>,
    generation: u32,
    now: i64,
    session_allowed: bool,
) -> Result<(), ProgramError> {
    let a = asset.try_borrow_data()?;
    let r = resident.try_borrow_data()?;
    let binding = resident_auth::Binding {
        asset: asset.key.to_bytes(),
        resident: resident.key.to_bytes(),
    };
    resident_auth::authorize(
        &binding,
        policy,
        &resident_auth::Account {
            key: asset.key.to_bytes(),
            owner: asset.owner.to_bytes(),
            data: &a,
        },
        &resident_auth::Account {
            key: resident.key.to_bytes(),
            owner: resident.owner.to_bytes(),
            data: &r,
        },
        actor.key.as_array(),
        actor.is_signer,
        generation,
        now,
        session_allowed,
    )
    .map_err(|e| ProgramError::Custom(e.error().code()))
}

/// Verify the immutable canonical link and current owner/session at the same
/// runtime invocation. The signed instruction must include `generation`.
#[allow(clippy::too_many_arguments)]
pub fn authorize(
    program: &Pubkey,
    config: &AccountInfo<'_>,
    link: &AccountInfo<'_>,
    citizen: &AccountInfo<'_>,
    asset: &AccountInfo<'_>,
    resident: &AccountInfo<'_>,
    actor: &AccountInfo<'_>,
    generation: u32,
    now: i64,
    session_allowed: bool,
    season: &Pubkey,
    season_id: u64,
) -> Result<(), ProgramError> {
    let policy = read_policy(program, config)?;
    check_addresses(
        program, &policy, link, citizen, asset, resident, season, season_id,
    )?;
    let data = link.try_borrow_data()?;
    let record = resident_binding::read(&data).ok_or(ProgramError::InvalidAccountData)?;
    if !resident_binding::same_identity(&record, asset.key.as_array(), resident.key.as_array()) {
        return Err(ProgramError::InvalidAccountData);
    }
    // This Season's Citizen is checked by its canonical address and its
    // presence in this Season (`check_addresses`), and its resident mark (the
    // asset) by the caller (`proc::resident::check`).
    check_actor(
        &policy,
        asset,
        resident,
        actor,
        generation,
        now,
        session_allowed,
    )
}

/// The first login of an NFT resident (`JoinResident`, experimental): with
/// the policy, the link, the future Citizen (at its Season's
/// `citizen_by_tag15(resident id)`) and the resident at the asset's canonical
/// addresses, the Citizen absent, and the actor the asset's current owner (no
/// session) at the signed generation with the transfer guard in place, create
/// the link if it is absent (recording this Citizen as the first); an
/// existing link must bind exactly this asset and resident — the Citizen it
/// recorded first, in another Season, is history and not compared. The
/// caller creates and writes the Citizen. One NFT has one link and one
/// Citizen address per Season, so a second Join of the same NFT in the same
/// Season finds the Citizen present and is refused.
#[cfg(feature = "nft-experimental")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn join_accounts<'a>(
    program: &Pubkey,
    config: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    link: &AccountInfo<'a>,
    citizen: &AccountInfo<'a>,
    asset: &AccountInfo<'a>,
    resident: &AccountInfo<'a>,
    actor: &AccountInfo<'a>,
    generation: u32,
    now: i64,
    season: &Pubkey,
) -> crate::R<()> {
    let policy = read_policy(program, config)?;
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (expected_link, expected_citizen, expected_resident) =
        canonical(program, &resident_program, asset.key, season);
    if link.key != &expected_link
        || citizen.key != &expected_citizen
        || resident.key != &expected_resident
    {
        return Err(crate::FrontierError::BadAddress.into());
    }
    if !link.is_writable || !citizen.is_writable {
        return Err(crate::error::BAD_ACCOUNT);
    }
    if !crate::init::is_absent(citizen) {
        return Err(crate::FrontierError::AlreadyDone.into());
    }
    check_actor(&policy, asset, resident, actor, generation, now, false)?;
    let record = resident_binding::Record {
        asset: asset.key.to_bytes(),
        resident: resident.key.to_bytes(),
        citizen: citizen.key.to_bytes(),
    };
    if crate::init::is_absent(link) {
        crate::init::init_nft_pda(
            payer,
            link,
            &[LINK_SEED, asset.key.as_ref()],
            resident_binding::LEN,
            program,
        )?;
        let mut data = link.try_borrow_mut_data()?;
        if !resident_binding::write_once(&mut data, &record) {
            return Err(crate::error::BAD_ACCOUNT);
        }
        Ok(())
    } else {
        if link.owner != program {
            return Err(crate::error::BAD_ACCOUNT);
        }
        let data = link.try_borrow_data()?;
        match resident_binding::read(&data) {
            Some(found)
                if resident_binding::same_identity(&found, &record.asset, &record.resident) =>
            {
                Ok(())
            }
            _ => Err(crate::error::BAD_ACCOUNT),
        }
    }
}
