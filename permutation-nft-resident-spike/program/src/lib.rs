//! Wylls resident program (spike, R2): an NFT-bound resident account whose
//! operating right is the Metaplex Core asset's current owner.
//!
//! Accounts (all PDAs of this program):
//!   config    `["config"]`                  authority, treasury, collection, price (test value), bump
//!   coll_auth `["collection-authority"]`    the Core collection's update authority and the permanent
//!                                           freeze / transfer delegate of every resident asset (signs by CPI only)
//!   resident  `["resident", asset]`         asset, bound tag15, gen, session {key, expiry, gen, setter}, ops, bump
//!
//! Instructions (tag byte first; integers little-endian):
//!   0x01 InitConfig  { price u64, treasury [u8;32], collection [u8;32] }   [authority s,w] [config w] [system] [program] [programdata]
//!        only the program's upgrade authority (LoaderV3 ProgramData) may write the config: otherwise anyone could
//!        initialise it first after a deployment and set their own treasury and collection.
//!   0x02 SetPrice    { price u64 }                                          [authority s] [config w]
//!   0x50 MintResident{ price u64 }   [payer s,w] [treasury w] [asset s,w] [collection w] [coll_auth] [resident w] [config] [core] [system]
//!        payer → treasury (price), Core CreateV1 into the collection (owner = payer, Permanent Freeze frozen=true and
//!        Permanent Transfer Delegate, both with authority = coll_auth), resident created at gen 0. One instruction:
//!        a failure anywhere undoes all of it (the runtime's atomicity).
//!   0x51 TransferResident {}         [owner s] [payer s,w] [asset w] [collection w] [coll_auth] [resident w] [new_owner] [core] [system]
//!        the current owner signs; the program moves the asset as permanent transfer delegate (forceApprove, frozen
//!        or not), gen += 1, session cleared — same instruction.
//!   0x52 SetSession  { key [u8;32], expiry i64 }   [owner s] [asset] [resident w]      recorded with the current gen and the setter
//!   0x53 Op          { gen u32 }     [actor s] [asset] [resident w]
//!        prologue: actor == asset.owner, or actor == session.key && setter == owner && session.gen == gen && now < expiry;
//!        then data.gen == resident.gen (else StaleGen). Effect: ops += 1 (a stand-in for a player action).
//!
//! Price, treasury: test values set by the config authority; not a product decision.
#![allow(clippy::too_many_arguments)]

use mpl_core::accounts::BaseAssetV1;
use mpl_core::instructions::{CreateV1CpiBuilder, TransferV1CpiBuilder};
use mpl_core::types::{
    DataState, PermanentFreezeDelegate, PermanentTransferDelegate, Plugin, PluginAuthority,
    PluginAuthorityPair,
};
use solana_program::account_info::{next_account_info, AccountInfo};
use solana_program::clock::Clock;
use solana_program::entrypoint::ProgramResult;
use solana_program::program::{invoke, invoke_signed};
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program::sysvar::Sysvar;
use solana_system_interface::instruction as system_instruction;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const CONFIG_SEED: &[u8] = b"config";
pub const COLLECTION_AUTHORITY_SEED: &[u8] = b"collection-authority";
pub const RESIDENT_SEED: &[u8] = b"resident";
/// Domain of the resident tag: `sha256("PSF-RES" ‖ asset)[0..15]` (the spike's ids.mjs).
pub const RESIDENT_TAG_DOMAIN: &[u8] = b"PSF-RES";

pub const TAG_INIT_CONFIG: u8 = 0x01;
pub const TAG_SET_PRICE: u8 = 0x02;
pub const TAG_MINT_RESIDENT: u8 = 0x50;
pub const TAG_TRANSFER_RESIDENT: u8 = 0x51;
pub const TAG_SET_SESSION: u8 = 0x52;
pub const TAG_OP: u8 = 0x53;

pub const CONFIG_MAGIC: u8 = 0xC1;
pub const RESIDENT_MAGIC: u8 = 0xC2;
/// config: magic 1 ‖ authority 32 ‖ treasury 32 ‖ collection 32 ‖ price 8 ‖ bump 1
pub const CONFIG_LEN: usize = 1 + 32 + 32 + 32 + 8 + 1;
/// resident: magic 1 ‖ asset 32 ‖ tag15 15 ‖ gen 4 ‖ session 32 ‖ expiry 8 ‖ session_gen 4 ‖ setter 32 ‖ ops 4 ‖ bump 1
pub const RESIDENT_LEN: usize = 1 + 32 + 15 + 4 + 32 + 8 + 4 + 32 + 4 + 1;
pub mod resident {
    pub const MAGIC: usize = 0;
    pub const ASSET: usize = 1;
    pub const TAG15: usize = 33;
    pub const GEN: usize = 48;
    pub const SESSION: usize = 52;
    pub const SESSION_EXPIRY: usize = 84;
    pub const SESSION_GEN: usize = 92;
    pub const SESSION_SETTER: usize = 96;
    pub const OPS: usize = 128;
    pub const BUMP: usize = 132;
}
pub mod config {
    pub const MAGIC: usize = 0;
    pub const AUTHORITY: usize = 1;
    pub const TREASURY: usize = 33;
    pub const COLLECTION: usize = 65;
    pub const PRICE: usize = 97;
    pub const BUMP: usize = 105;
}
/// Longest session from its setting (30 days, as the Frontier Citizen).
pub const MAX_SESSION_SECS: i64 = 30 * 86_400;

/// Stable custom error codes (the tests and the JS side match on them).
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResidentError {
    BadData = 1000,
    BadAddress = 1001,
    Auth = 1002,
    NotOwner = 1003,
    StaleGen = 1004,
    PriceChanged = 1005,
    WrongTreasury = 1006,
    WrongCollection = 1007,
    AlreadyInitialized = 1008,
    NotInitialized = 1009,
    SessionExpiry = 1010,
    /// InitConfig signed by a key that is not the program's upgrade authority (or the program is immutable).
    NotUpgradeAuthority = 1011,
}
impl From<ResidentError> for ProgramError {
    fn from(e: ResidentError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub fn config_address(program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program)
}
pub fn collection_authority_address(program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[COLLECTION_AUTHORITY_SEED], program)
}
pub fn resident_address(program: &Pubkey, asset: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[RESIDENT_SEED, asset.as_ref()], program)
}
/// `sha256("PSF-RES" ‖ asset)[0..15]`.
pub fn resident_tag15(asset: &Pubkey) -> [u8; 15] {
    let h = solana_program::hash::hashv(&[RESIDENT_TAG_DOMAIN, asset.as_ref()]);
    let mut t = [0u8; 15];
    t.copy_from_slice(&h.to_bytes()[..15]);
    t
}

fn rd_u64(d: &[u8], o: usize) -> Result<u64, ProgramError> {
    d.get(o..o + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).ok_or(ResidentError::BadData.into())
}
fn rd_u32(d: &[u8], o: usize) -> Result<u32, ProgramError> {
    d.get(o..o + 4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).ok_or(ResidentError::BadData.into())
}
fn rd_i64(d: &[u8], o: usize) -> Result<i64, ProgramError> {
    d.get(o..o + 8).map(|b| i64::from_le_bytes(b.try_into().unwrap())).ok_or(ResidentError::BadData.into())
}
fn rd_key(d: &[u8], o: usize) -> Result<Pubkey, ProgramError> {
    d.get(o..o + 32).map(|b| Pubkey::new_from_array(b.try_into().unwrap())).ok_or(ResidentError::BadData.into())
}
fn wr(d: &mut [u8], o: usize, b: &[u8]) {
    d[o..o + b.len()].copy_from_slice(b);
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (&tag, rest) = data.split_first().ok_or(ResidentError::BadData)?;
    match tag {
        TAG_INIT_CONFIG => init_config(program_id, accounts, rest),
        TAG_SET_PRICE => set_price(program_id, accounts, rest),
        TAG_MINT_RESIDENT => mint_resident(program_id, accounts, rest),
        TAG_TRANSFER_RESIDENT => transfer_resident(program_id, accounts),
        TAG_SET_SESSION => set_session(program_id, accounts, rest),
        TAG_OP => op(program_id, accounts, rest),
        _ => Err(ResidentError::BadData.into()),
    }
}

/// Creates `account` at a PDA of this program with `seeds` (the bump appended), `space` bytes, rent paid by `payer`.
fn create_pda<'a>(payer: &AccountInfo<'a>, account: &AccountInfo<'a>, system: &AccountInfo<'a>, program_id: &Pubkey, seeds: &[&[u8]], bump: u8, space: usize) -> ProgramResult {
    let lamports = Rent::get()?.minimum_balance(space);
    let bump_seed = [bump];
    let mut full: Vec<&[u8]> = seeds.to_vec();
    full.push(&bump_seed);
    invoke_signed(
        &system_instruction::create_account(payer.key, account.key, lamports, space as u64, program_id),
        &[payer.clone(), account.clone(), system.clone()],
        &[&full],
    )
}

/// The BPF Upgradeable Loader (LoaderV3).
const LOADER_V3: Pubkey = solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// The upgrade authority stored in `programdata` for `program`: the Program
/// account (`UpgradeableLoaderState::Program`, tag 2) names its ProgramData
/// (tag 3), whose `Option<authority>` is at byte 12. `None` when immutable.
pub fn upgrade_authority(
    program_id: &Pubkey,
    program_key: &Pubkey,
    program_owner: &Pubkey,
    program_data: &[u8],
    programdata_key: &Pubkey,
    programdata_owner: &Pubkey,
    programdata: &[u8],
) -> Result<Option<Pubkey>, ProgramError> {
    if program_key != program_id || *program_owner != LOADER_V3 || *programdata_owner != LOADER_V3 {
        return Err(ResidentError::BadAddress.into());
    }
    if rd_u32(program_data, 0)? != 2 || rd_key(program_data, 4)? != *programdata_key {
        return Err(ResidentError::BadAddress.into());
    }
    if rd_u32(programdata, 0)? != 3 {
        return Err(ResidentError::BadAddress.into());
    }
    match programdata.get(12) {
        Some(1) => Ok(Some(rd_key(programdata, 13)?)),
        Some(0) => Ok(None),
        _ => Err(ResidentError::BadData.into()),
    }
}

fn init_config(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let cfg = next_account_info(it)?;
    let system = next_account_info(it)?;
    let program = next_account_info(it)?;
    let programdata = next_account_info(it)?;
    if !authority.is_signer {
        return Err(ResidentError::Auth.into());
    }
    let ua = upgrade_authority(
        program_id,
        program.key,
        program.owner,
        &program.try_borrow_data()?,
        programdata.key,
        programdata.owner,
        &programdata.try_borrow_data()?,
    )?;
    if ua != Some(*authority.key) {
        return Err(ResidentError::NotUpgradeAuthority.into());
    }
    let (addr, bump) = config_address(program_id);
    if *cfg.key != addr {
        return Err(ResidentError::BadAddress.into());
    }
    if !cfg.data_is_empty() {
        return Err(ResidentError::AlreadyInitialized.into());
    }
    let price = rd_u64(d, 0)?;
    let treasury = rd_key(d, 8)?;
    let collection = rd_key(d, 40)?;
    create_pda(authority, cfg, system, program_id, &[CONFIG_SEED], bump, CONFIG_LEN)?;
    let mut c = cfg.try_borrow_mut_data()?;
    c[config::MAGIC] = CONFIG_MAGIC;
    wr(&mut c, config::AUTHORITY, authority.key.as_ref());
    wr(&mut c, config::TREASURY, treasury.as_ref());
    wr(&mut c, config::COLLECTION, collection.as_ref());
    wr(&mut c, config::PRICE, &price.to_le_bytes());
    c[config::BUMP] = bump;
    Ok(())
}

fn set_price(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let cfg = next_account_info(it)?;
    check_config(program_id, cfg)?;
    let mut c = cfg.try_borrow_mut_data()?;
    if !authority.is_signer || rd_key(&c, config::AUTHORITY)? != *authority.key {
        return Err(ResidentError::Auth.into());
    }
    let price = rd_u64(d, 0)?;
    wr(&mut c, config::PRICE, &price.to_le_bytes());
    Ok(())
}

fn check_config(program_id: &Pubkey, cfg: &AccountInfo) -> ProgramResult {
    if *cfg.key != config_address(program_id).0 {
        return Err(ResidentError::BadAddress.into());
    }
    if cfg.owner != program_id || cfg.data_len() != CONFIG_LEN || cfg.try_borrow_data()?[config::MAGIC] != CONFIG_MAGIC {
        return Err(ResidentError::NotInitialized.into());
    }
    Ok(())
}

fn check_resident<'a>(program_id: &Pubkey, resident: &AccountInfo<'a>, asset: &AccountInfo<'a>) -> ProgramResult {
    if *resident.key != resident_address(program_id, asset.key).0 {
        return Err(ResidentError::BadAddress.into());
    }
    let r = resident.try_borrow_data()?;
    if resident.owner != program_id || r.len() != RESIDENT_LEN || r[resident::MAGIC] != RESIDENT_MAGIC || rd_key(&r, resident::ASSET)? != *asset.key {
        return Err(ResidentError::NotInitialized.into());
    }
    Ok(())
}

/// The asset's current owner from its Core account (the base struct), after checking the account is Core's.
fn asset_owner(asset: &AccountInfo) -> Result<Pubkey, ProgramError> {
    if *asset.owner != mpl_core::ID {
        return Err(ResidentError::BadAddress.into());
    }
    let base = BaseAssetV1::from_bytes(&asset.try_borrow_data()?).map_err(|_| ResidentError::BadData)?;
    Ok(base.owner)
}

fn mint_resident(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let treasury = next_account_info(it)?;
    let asset = next_account_info(it)?;
    let collection = next_account_info(it)?;
    let coll_auth = next_account_info(it)?;
    let resident = next_account_info(it)?;
    let cfg = next_account_info(it)?;
    let core = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !payer.is_signer || !asset.is_signer {
        return Err(ResidentError::Auth.into());
    }
    check_config(program_id, cfg)?;
    let (price_cfg, treasury_cfg, collection_cfg) = {
        let c = cfg.try_borrow_data()?;
        (rd_u64(&c, config::PRICE)?, rd_key(&c, config::TREASURY)?, rd_key(&c, config::COLLECTION)?)
    };
    if rd_u64(d, 0)? != price_cfg {
        return Err(ResidentError::PriceChanged.into());
    }
    if *treasury.key != treasury_cfg {
        return Err(ResidentError::WrongTreasury.into());
    }
    if *collection.key != collection_cfg {
        return Err(ResidentError::WrongCollection.into());
    }
    let (ca, ca_bump) = collection_authority_address(program_id);
    if *coll_auth.key != ca || *core.key != mpl_core::ID {
        return Err(ResidentError::BadAddress.into());
    }
    let (ra, r_bump) = resident_address(program_id, asset.key);
    if *resident.key != ra {
        return Err(ResidentError::BadAddress.into());
    }
    if !resident.data_is_empty() {
        return Err(ResidentError::AlreadyInitialized.into());
    }
    // 1. the payment
    invoke(&system_instruction::transfer(payer.key, treasury.key, price_cfg), &[payer.clone(), treasury.clone(), system.clone()])?;
    // 2. the Core asset, guarded: both permanent plugins with this program's PDA as authority (creation-only, never revoked)
    let ca_seeds: &[&[u8]] = &[COLLECTION_AUTHORITY_SEED, &[ca_bump]];
    CreateV1CpiBuilder::new(core)
        .asset(asset)
        .collection(Some(collection))
        .authority(Some(coll_auth))
        .payer(payer)
        .owner(Some(payer))
        .update_authority(None)
        .system_program(system)
        .log_wrapper(None)
        .data_state(DataState::AccountState)
        .name(String::from("Wylls Resident (test)"))
        .uri(String::from("https://wylls.test/resident.json"))
        .plugins(vec![
            PluginAuthorityPair { plugin: Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: true }), authority: Some(PluginAuthority::Address { address: ca }) },
            PluginAuthorityPair { plugin: Plugin::PermanentTransferDelegate(PermanentTransferDelegate {}), authority: Some(PluginAuthority::Address { address: ca }) },
        ])
        .invoke_signed(&[ca_seeds])?;
    // 3. the resident account, generation 0, bound to the asset
    create_pda(payer, resident, system, program_id, &[RESIDENT_SEED, asset.key.as_ref()], r_bump, RESIDENT_LEN)?;
    let mut r = resident.try_borrow_mut_data()?;
    r[resident::MAGIC] = RESIDENT_MAGIC;
    wr(&mut r, resident::ASSET, asset.key.as_ref());
    wr(&mut r, resident::TAG15, &resident_tag15(asset.key));
    wr(&mut r, resident::GEN, &0u32.to_le_bytes());
    r[resident::BUMP] = r_bump;
    Ok(())
}

fn transfer_resident(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let owner = next_account_info(it)?;
    let payer = next_account_info(it)?;
    let asset = next_account_info(it)?;
    let collection = next_account_info(it)?;
    let coll_auth = next_account_info(it)?;
    let resident = next_account_info(it)?;
    let new_owner = next_account_info(it)?;
    let core = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !owner.is_signer || !payer.is_signer {
        return Err(ResidentError::Auth.into());
    }
    if asset_owner(asset)? != *owner.key {
        return Err(ResidentError::NotOwner.into());
    }
    check_resident(program_id, resident, asset)?;
    let (ca, ca_bump) = collection_authority_address(program_id);
    if *coll_auth.key != ca || *core.key != mpl_core::ID {
        return Err(ResidentError::BadAddress.into());
    }
    // The program, as permanent transfer delegate, moves the asset (forceApprove: the permanent freeze does not stop it).
    let ca_seeds: &[&[u8]] = &[COLLECTION_AUTHORITY_SEED, &[ca_bump]];
    TransferV1CpiBuilder::new(core)
        .asset(asset)
        .collection(Some(collection))
        .payer(payer)
        .authority(Some(coll_auth))
        .new_owner(new_owner)
        .system_program(Some(system))
        .log_wrapper(None)
        .invoke_signed(&[ca_seeds])?;
    // Same instruction: the generation moves and the session is gone.
    let mut r = resident.try_borrow_mut_data()?;
    let gen = rd_u32(&r, resident::GEN)?.checked_add(1).ok_or(ResidentError::BadData)?;
    wr(&mut r, resident::GEN, &gen.to_le_bytes());
    wr(&mut r, resident::SESSION, &[0u8; 32]);
    wr(&mut r, resident::SESSION_EXPIRY, &0i64.to_le_bytes());
    wr(&mut r, resident::SESSION_GEN, &0u32.to_le_bytes());
    wr(&mut r, resident::SESSION_SETTER, &[0u8; 32]);
    Ok(())
}

fn set_session(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let owner = next_account_info(it)?;
    let asset = next_account_info(it)?;
    let resident = next_account_info(it)?;
    if !owner.is_signer {
        return Err(ResidentError::Auth.into());
    }
    if asset_owner(asset)? != *owner.key {
        return Err(ResidentError::NotOwner.into());
    }
    check_resident(program_id, resident, asset)?;
    let key = rd_key(d, 0)?;
    let expiry = rd_i64(d, 32)?;
    let now = Clock::get()?.unix_timestamp;
    if expiry > now.saturating_add(MAX_SESSION_SECS) {
        return Err(ResidentError::SessionExpiry.into());
    }
    let mut r = resident.try_borrow_mut_data()?;
    let gen = rd_u32(&r, resident::GEN)?;
    wr(&mut r, resident::SESSION, key.as_ref());
    wr(&mut r, resident::SESSION_EXPIRY, &expiry.to_le_bytes());
    wr(&mut r, resident::SESSION_GEN, &gen.to_le_bytes());
    wr(&mut r, resident::SESSION_SETTER, owner.key.as_ref());
    Ok(())
}

fn op(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let actor = next_account_info(it)?;
    let asset = next_account_info(it)?;
    let resident = next_account_info(it)?;
    if !actor.is_signer {
        return Err(ResidentError::Auth.into());
    }
    let owner = asset_owner(asset)?;
    check_resident(program_id, resident, asset)?;
    let mut r = resident.try_borrow_mut_data()?;
    let gen = rd_u32(&r, resident::GEN)?;
    if *actor.key != owner {
        // A session key: set by the current owner, in the current generation, unexpired.
        let session = rd_key(&r, resident::SESSION)?;
        let setter = rd_key(&r, resident::SESSION_SETTER)?;
        let sgen = rd_u32(&r, resident::SESSION_GEN)?;
        let expiry = rd_i64(&r, resident::SESSION_EXPIRY)?;
        let now = Clock::get()?.unix_timestamp;
        if session != *actor.key || setter != owner || sgen != gen || now >= expiry {
            return Err(ResidentError::NotOwner.into());
        }
    }
    if rd_u32(d, 0)? != gen {
        return Err(ResidentError::StaleGen.into());
    }
    let ops = rd_u32(&r, resident::OPS)?.checked_add(1).ok_or(ResidentError::BadData)?;
    wr(&mut r, resident::OPS, &ops.to_le_bytes());
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Literal bytes only: no key is generated, derived or signed.
    use super::*;

    const P: Pubkey = Pubkey::new_from_array([0x11; 32]);
    const PD: Pubkey = Pubkey::new_from_array([0x12; 32]);
    const UA: Pubkey = Pubkey::new_from_array([0x13; 32]);

    fn program_bytes(pd: &Pubkey) -> Vec<u8> {
        let mut d = 2u32.to_le_bytes().to_vec();
        d.extend_from_slice(pd.as_ref());
        d
    }
    fn programdata_bytes(ua: Option<&Pubkey>) -> Vec<u8> {
        let mut d = 3u32.to_le_bytes().to_vec();
        d.extend_from_slice(&7u64.to_le_bytes());
        match ua {
            Some(k) => {
                d.push(1);
                d.extend_from_slice(k.as_ref());
            }
            None => d.push(0),
        }
        d
    }

    #[test]
    fn the_upgrade_authority_is_read_from_the_programdata_of_this_program() {
        let got = upgrade_authority(&P, &P, &LOADER_V3, &program_bytes(&PD), &PD, &LOADER_V3, &programdata_bytes(Some(&UA)));
        assert_eq!(got, Ok(Some(UA)));
        // Immutable program: no authority, so InitConfig is refused.
        let none = upgrade_authority(&P, &P, &LOADER_V3, &program_bytes(&PD), &PD, &LOADER_V3, &programdata_bytes(None));
        assert_eq!(none, Ok(None));
    }

    #[test]
    fn another_programs_or_a_forged_programdata_is_refused() {
        let other = Pubkey::new_from_array([0x21; 32]);
        let bad = Err(ProgramError::from(ResidentError::BadAddress));
        // Another program's accounts.
        assert_eq!(upgrade_authority(&P, &other, &LOADER_V3, &program_bytes(&PD), &PD, &LOADER_V3, &programdata_bytes(Some(&UA))), bad);
        // The Program account names another ProgramData.
        assert_eq!(upgrade_authority(&P, &P, &LOADER_V3, &program_bytes(&other), &PD, &LOADER_V3, &programdata_bytes(Some(&UA))), bad);
        // A ProgramData not owned by the loader (forged bytes).
        assert_eq!(upgrade_authority(&P, &P, &LOADER_V3, &program_bytes(&PD), &PD, &other, &programdata_bytes(Some(&UA))), bad);
        // Not a ProgramData (wrong tag).
        let mut wrong = programdata_bytes(Some(&UA));
        wrong[0] = 2;
        assert_eq!(upgrade_authority(&P, &P, &LOADER_V3, &program_bytes(&PD), &PD, &LOADER_V3, &wrong), bad);
    }
}
