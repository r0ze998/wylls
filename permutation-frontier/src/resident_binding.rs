//! Experimental program-side checks for one NFT / one Citizen.
//!
//! No instruction calls these functions yet. In particular world configuration
//! wiring, Citizen creation, legacy migration and the player prologue are NOT
//! implemented here. Callers must obtain `season_id` from trusted program-owned
//! world configuration, `now` from the runtime clock, and `generation` from
//! signed instruction data, never untrusted substitutions. The configuration
//! account creation helper below has not been exercised in a runtime test.
//! The proposed addresses are global to this Frontier program, not per season.

use frontier_abi::{resident_auth, resident_binding, resident_policy};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

const LINK_SEED: &[u8] = b"nft-citizen-link";
const CITIZEN_SEED: &[u8] = b"nft-citizen";
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

/// The program address of `asset`'s NFT Citizen, `["nft-citizen", asset]`.
pub(crate) fn citizen_address(program: &Pubkey, asset: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CITIZEN_SEED, asset.as_ref()], program).0
}

fn canonical(
    program: &Pubkey,
    resident_program: &Pubkey,
    asset: &Pubkey,
) -> (Pubkey, Pubkey, Pubkey) {
    let link = Pubkey::find_program_address(&[LINK_SEED, asset.as_ref()], program).0;
    let citizen = Pubkey::find_program_address(&[CITIZEN_SEED, asset.as_ref()], program).0;
    let resident =
        Pubkey::find_program_address(&[RESIDENT_SEED, asset.as_ref()], resident_program).0;
    (link, citizen, resident)
}

/// Refuse any noncanonical account even if its data looks like a valid link.
fn check_addresses(
    program: &Pubkey,
    policy: &resident_auth::Policy,
    link: &AccountInfo<'_>,
    citizen: &AccountInfo<'_>,
    asset: &AccountInfo<'_>,
    resident: &AccountInfo<'_>,
    season_id: u64,
) -> Result<(), ProgramError> {
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (expected_link, expected_citizen, expected_resident) =
        canonical(program, &resident_program, asset.key);
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
    .map_err(|_| ProgramError::InvalidAccountData)
}

/// Initialize an already allocated, program-owned link exactly once. The
/// Citizen must already exist at the asset-derived address. This function does
/// not create either account; it requires the current asset owner, not a
/// delegated session. The supplied generation must come from signed data.
#[allow(clippy::too_many_arguments)]
pub fn initialize(
    program: &Pubkey,
    config: &AccountInfo<'_>,
    link: &AccountInfo<'_>,
    citizen: &AccountInfo<'_>,
    asset: &AccountInfo<'_>,
    resident: &AccountInfo<'_>,
    actor: &AccountInfo<'_>,
    generation: u32,
    now: i64,
    season_id: u64,
) -> Result<(), ProgramError> {
    let policy = read_policy(program, config)?;
    check_addresses(program, &policy, link, citizen, asset, resident, season_id)?;
    if !link.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    check_actor(&policy, asset, resident, actor, generation, now, false)?;
    let mut data = link.try_borrow_mut_data()?;
    let record = resident_binding::Record {
        asset: asset.key.to_bytes(),
        resident: resident.key.to_bytes(),
        citizen: citizen.key.to_bytes(),
    };
    if !resident_binding::write_once(&mut data, &record) {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    Ok(())
}

/// Create the canonical link and initialize it in the same instruction. The
/// owner and payer are checked separately; the Citizen must already exist at
/// its proposed canonical address. A second creation is refused as present.
/// No instruction dispatches to this helper yet.
#[allow(clippy::too_many_arguments)]
pub fn create_and_initialize<'a>(
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
    season_id: u64,
) -> crate::R<()> {
    let policy = read_policy(program, config)?;
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (expected_link, expected_citizen, expected_resident) =
        canonical(program, &resident_program, asset.key);
    if link.key != &expected_link
        || citizen.key != &expected_citizen
        || resident.key != &expected_resident
    {
        return Err(crate::FrontierError::BadAddress.into());
    }
    crate::prologue::present_v2(
        citizen,
        program,
        frontier_abi::v2::layout::AccountKind::Citizen,
        season_id,
    )?;
    check_actor(&policy, asset, resident, actor, generation, now, false)?;
    crate::init::init_nft_pda(
        payer,
        link,
        &[LINK_SEED, asset.key.as_ref()],
        resident_binding::LEN,
        program,
    )?;
    initialize(
        program, config, link, citizen, asset, resident, actor, generation, now, season_id,
    )?;
    Ok(())
}

/// Register an NFT before its game Citizen exists. The future Citizen address
/// is deterministic; the link's creation and initial write happen together.
/// This does not create a playable Citizen or change the old player prologue.
#[allow(clippy::too_many_arguments)]
pub fn register_new<'a>(
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
) -> crate::R<()> {
    let policy = read_policy(program, config)?;
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (expected_link, expected_citizen, expected_resident) =
        canonical(program, &resident_program, asset.key);
    if link.key != &expected_link
        || citizen.key != &expected_citizen
        || resident.key != &expected_resident
    {
        return Err(crate::FrontierError::BadAddress.into());
    }
    if !crate::init::is_absent(citizen) {
        return Err(crate::error::BAD_ACCOUNT);
    }
    check_actor(&policy, asset, resident, actor, generation, now, false)?;
    crate::init::init_nft_pda(
        payer,
        link,
        &[LINK_SEED, asset.key.as_ref()],
        resident_binding::LEN,
        program,
    )?;
    let record = resident_binding::Record {
        asset: asset.key.to_bytes(),
        resident: resident.key.to_bytes(),
        citizen: citizen.key.to_bytes(),
    };
    let mut data = link.try_borrow_mut_data()?;
    if !resident_binding::write_once(&mut data, &record) {
        return Err(crate::error::BAD_ACCOUNT);
    }
    Ok(())
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
    season_id: u64,
) -> Result<(), ProgramError> {
    let policy = read_policy(program, config)?;
    check_addresses(program, &policy, link, citizen, asset, resident, season_id)?;
    let data = link.try_borrow_data()?;
    let record = resident_binding::read(&data).ok_or(ProgramError::InvalidAccountData)?;
    if !resident_binding::matches(
        &record,
        asset.key.as_array(),
        resident.key.as_array(),
        citizen.key.as_array(),
    ) {
        return Err(ProgramError::InvalidAccountData);
    }
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

/// The first login of an NFT resident (`Join`, experimental): with the
/// policy, the link, the future Citizen and the resident at the asset's
/// canonical addresses, the Citizen absent, and the actor the asset's
/// current owner (no session) at the signed generation with the transfer
/// guard in place, create the link if it is absent (an existing link must
/// name exactly this asset, resident and Citizen: `Register` may have made
/// it first), then allocate the Citizen at `["nft-citizen", asset]` with
/// `space` bytes, owned by this program. The caller writes the Citizen.
/// One NFT has one link and one Citizen address, so a second Join of the
/// same NFT finds the Citizen present and is refused.
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
    space: usize,
) -> crate::R<()> {
    let policy = read_policy(program, config)?;
    let resident_program = Pubkey::new_from_array(policy.resident_program);
    let (expected_link, expected_citizen, expected_resident) =
        canonical(program, &resident_program, asset.key);
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
    } else {
        if link.owner != program {
            return Err(crate::error::BAD_ACCOUNT);
        }
        let data = link.try_borrow_data()?;
        let found = resident_binding::read(&data).ok_or(crate::error::BAD_ACCOUNT)?;
        if found != record {
            return Err(crate::error::BAD_ACCOUNT);
        }
    }
    crate::init::init_nft_pda(
        payer,
        citizen,
        &[CITIZEN_SEED, asset.key.as_ref()],
        space,
        program,
    )
}
