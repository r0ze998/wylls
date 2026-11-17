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
//!   0x03 SetTerms    { max_supply u64, sale_start i64, sale_end i64, per_wallet u16, open u8 }  [authority s] [config w]
//!   0x04 SetTreasury { treasury [u8;32] }                                   [authority s] [config w]
//!   0x05 SetMetadata { name_len u8, name, uri_len u8, uri }                 [authority s] [config w]
//!   0x06 ProposeAuthority { new [u8;32] } [authority s] [config w];  0x07 AcceptAuthority {} [new s] [config w]
//!        Every sale value (price, supply, treasury, window, per-wallet limit, the NFT's name and URI) is the
//!        config authority's setting: none is fixed here. The sale starts closed (open = 0, max_supply = 0)
//!        and MintResident refuses until the authority opens it.
//!   0x50 MintResident{ price u64 }   [payer s,w] [treasury w] [asset s,w] [collection w] [coll_auth] [resident w] [config w] [core] [system] [minter w]
//!        the sale must be open, inside its window, below max_supply and (per_wallet > 0) below the payer's limit
//!        (`minter` = `["minted-by", payer]`, created on the payer's first mint when a limit is set);
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
pub const TAG_SET_TERMS: u8 = 0x03;
pub const TAG_SET_TREASURY: u8 = 0x04;
pub const TAG_SET_METADATA: u8 = 0x05;
pub const TAG_PROPOSE_AUTHORITY: u8 = 0x06;
pub const TAG_ACCEPT_AUTHORITY: u8 = 0x07;
pub const MINTER_SEED: &[u8] = b"minted-by";
/// minter: magic 1 ‖ wallet 32 ‖ minted u16 ‖ bump 1
pub const MINTER_MAGIC: u8 = 0xC4;
pub const MINTER_LEN: usize = 1 + 32 + 2 + 1;
pub const NAME_MAX: usize = 32;
pub const URI_MAX: usize = 200;
pub const TAG_MINT_RESIDENT: u8 = 0x50;
pub const TAG_TRANSFER_RESIDENT: u8 = 0x51;
pub const TAG_SET_SESSION: u8 = 0x52;
pub const TAG_OP: u8 = 0x53;

/// Config layout v2 (sale terms, metadata, authority hand-over); v1 was 0xC1.
pub const CONFIG_MAGIC: u8 = 0xC3;
pub const RESIDENT_MAGIC: u8 = 0xC2;
/// config: magic 1 ‖ authority 32 ‖ treasury 32 ‖ collection 32 ‖ price 8 ‖ bump 1 ‖ pending_authority 32 ‖
/// max_supply 8 ‖ minted 8 ‖ sale_start 8 ‖ sale_end 8 ‖ per_wallet 2 ‖ open 1 ‖ name_len 1 ‖ name 32 ‖ uri_len 1 ‖ uri 200
pub const CONFIG_LEN: usize = 1 + 32 + 32 + 32 + 8 + 1 + 32 + 8 + 8 + 8 + 8 + 2 + 1 + 1 + NAME_MAX + 1 + URI_MAX;
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
    pub const PENDING: usize = 106;
    pub const MAX_SUPPLY: usize = 138;
    pub const MINTED: usize = 146;
    pub const SALE_START: usize = 154;
    pub const SALE_END: usize = 162;
    pub const PER_WALLET: usize = 170;
    pub const OPEN: usize = 172;
    pub const NAME_LEN: usize = 173;
    pub const NAME: usize = 174;
    pub const URI_LEN: usize = 206;
    pub const URI: usize = 207;
}
const _: () = assert!(config::URI + URI_MAX == CONFIG_LEN);

/// The sale terms the config authority set (no value is fixed by the program).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub price: u64,
    pub max_supply: u64,
    pub minted: u64,
    pub sale_start: i64,
    pub sale_end: i64,
    pub per_wallet: u16,
    pub open: bool,
}

impl Terms {
    pub fn read(c: &[u8]) -> Result<Terms, ProgramError> {
        Ok(Terms {
            price: rd_u64(c, config::PRICE)?,
            max_supply: rd_u64(c, config::MAX_SUPPLY)?,
            minted: rd_u64(c, config::MINTED)?,
            sale_start: rd_i64(c, config::SALE_START)?,
            sale_end: rd_i64(c, config::SALE_END)?,
            per_wallet: u16::from_le_bytes(c.get(config::PER_WALLET..config::PER_WALLET + 2).ok_or(ResidentError::BadData)?.try_into().unwrap()),
            open: *c.get(config::OPEN).ok_or(ResidentError::BadData)? == 1,
        })
    }
}

/// Whether one more NFT may be minted now by a wallet that has minted
/// `wallet_minted` (counted only when `per_wallet > 0`).
pub fn sale_check(t: &Terms, now: i64, wallet_minted: u16) -> Result<(), ResidentError> {
    if !t.open {
        return Err(ResidentError::SaleClosed);
    }
    if t.max_supply == 0 {
        return Err(ResidentError::SupplyNotSet);
    }
    if t.minted >= t.max_supply {
        return Err(ResidentError::SoldOut);
    }
    if t.sale_start != 0 && now < t.sale_start {
        return Err(ResidentError::SaleNotStarted);
    }
    if t.sale_end != 0 && now >= t.sale_end {
        return Err(ResidentError::SaleEnded);
    }
    if t.per_wallet > 0 && wallet_minted >= t.per_wallet {
        return Err(ResidentError::WalletLimit);
    }
    Ok(())
}

/// Whether new terms are consistent: the supply never below what is minted,
/// the window ordered, and an open sale with a supply and the NFT's name and URI set.
pub fn terms_check(t: &Terms, name_len: u8, uri_len: u8) -> Result<(), ResidentError> {
    if t.max_supply < t.minted {
        return Err(ResidentError::BadTerms);
    }
    if t.sale_end != 0 && t.sale_end <= t.sale_start {
        return Err(ResidentError::BadTerms);
    }
    if t.open && (t.max_supply == 0 || name_len == 0 || uri_len == 0) {
        return Err(ResidentError::MetadataNotSet);
    }
    Ok(())
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
    /// The sale is not open (the authority has not opened it, or closed it).
    SaleClosed = 1012,
    /// No supply is set (max_supply = 0).
    SupplyNotSet = 1013,
    SoldOut = 1014,
    SaleNotStarted = 1015,
    SaleEnded = 1016,
    /// The payer reached the per-wallet limit.
    WalletLimit = 1017,
    /// Inconsistent terms (supply below minted, window out of order) or metadata too long.
    BadTerms = 1018,
    /// Opening a sale needs a supply and the NFT's name and URI.
    MetadataNotSet = 1019,
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
/// The per-wallet mint count of `wallet` (`["minted-by", wallet]`).
pub fn minter_address(program: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MINTER_SEED, wallet.as_ref()], program)
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
        TAG_SET_TERMS => set_terms(program_id, accounts, rest),
        TAG_SET_TREASURY => set_treasury(program_id, accounts, rest),
        TAG_SET_METADATA => set_metadata(program_id, accounts, rest),
        TAG_PROPOSE_AUTHORITY => propose_authority(program_id, accounts, rest),
        TAG_ACCEPT_AUTHORITY => accept_authority(program_id, accounts),
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

/// The config, writable, and its authority's signature.
fn authority_config<'a, 'b>(program_id: &Pubkey, accounts: &'a [AccountInfo<'b>]) -> Result<&'a AccountInfo<'b>, ProgramError> {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let cfg = next_account_info(it)?;
    check_config(program_id, cfg)?;
    if !authority.is_signer || rd_key(&cfg.try_borrow_data()?, config::AUTHORITY)? != *authority.key {
        return Err(ResidentError::Auth.into());
    }
    Ok(cfg)
}

fn set_terms(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let cfg = authority_config(program_id, accounts)?;
    if d.len() != 8 + 8 + 8 + 2 + 1 || d[26] > 1 {
        return Err(ResidentError::BadData.into());
    }
    let mut c = cfg.try_borrow_mut_data()?;
    let mut t = Terms::read(&c)?;
    t.max_supply = rd_u64(d, 0)?;
    t.sale_start = rd_i64(d, 8)?;
    t.sale_end = rd_i64(d, 16)?;
    t.per_wallet = u16::from_le_bytes([d[24], d[25]]);
    t.open = d[26] == 1;
    terms_check(&t, c[config::NAME_LEN], c[config::URI_LEN])?;
    wr(&mut c, config::MAX_SUPPLY, &t.max_supply.to_le_bytes());
    wr(&mut c, config::SALE_START, &t.sale_start.to_le_bytes());
    wr(&mut c, config::SALE_END, &t.sale_end.to_le_bytes());
    wr(&mut c, config::PER_WALLET, &t.per_wallet.to_le_bytes());
    c[config::OPEN] = t.open as u8;
    Ok(())
}

fn set_treasury(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let cfg = authority_config(program_id, accounts)?;
    let treasury = rd_key(d, 0)?;
    if d.len() != 32 || treasury == Pubkey::default() {
        return Err(ResidentError::BadData.into());
    }
    wr(&mut cfg.try_borrow_mut_data()?, config::TREASURY, treasury.as_ref());
    Ok(())
}

/// `name_len u8 ‖ name ‖ uri_len u8 ‖ uri` (UTF-8, at most NAME_MAX and URI_MAX bytes).
pub fn parse_metadata(d: &[u8]) -> Result<(&[u8], &[u8]), ResidentError> {
    let n = *d.first().ok_or(ResidentError::BadData)? as usize;
    let name = d.get(1..1 + n).ok_or(ResidentError::BadData)?;
    let u = *d.get(1 + n).ok_or(ResidentError::BadData)? as usize;
    let uri = d.get(2 + n..2 + n + u).ok_or(ResidentError::BadData)?;
    if d.len() != 2 + n + u || n > NAME_MAX || u > URI_MAX || core::str::from_utf8(name).is_err() || core::str::from_utf8(uri).is_err() {
        return Err(ResidentError::BadTerms);
    }
    Ok((name, uri))
}

fn set_metadata(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let cfg = authority_config(program_id, accounts)?;
    let (name, uri) = parse_metadata(d)?;
    let mut c = cfg.try_borrow_mut_data()?;
    // An open sale keeps a name and a URI.
    if c[config::OPEN] == 1 && (name.is_empty() || uri.is_empty()) {
        return Err(ResidentError::MetadataNotSet.into());
    }
    c[config::NAME..config::NAME + NAME_MAX].fill(0);
    c[config::URI..config::URI + URI_MAX].fill(0);
    c[config::NAME_LEN] = name.len() as u8;
    wr(&mut c, config::NAME, name);
    c[config::URI_LEN] = uri.len() as u8;
    wr(&mut c, config::URI, uri);
    Ok(())
}

/// Two steps: the authority names a successor, the successor accepts (a typo never loses the config).
fn propose_authority(program_id: &Pubkey, accounts: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let cfg = authority_config(program_id, accounts)?;
    if d.len() != 32 {
        return Err(ResidentError::BadData.into());
    }
    wr(&mut cfg.try_borrow_mut_data()?, config::PENDING, &d[..32]);
    Ok(())
}

fn accept_authority(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let new = next_account_info(it)?;
    let cfg = next_account_info(it)?;
    check_config(program_id, cfg)?;
    let mut c = cfg.try_borrow_mut_data()?;
    let pending = rd_key(&c, config::PENDING)?;
    if !new.is_signer || pending == Pubkey::default() || pending != *new.key {
        return Err(ResidentError::Auth.into());
    }
    wr(&mut c, config::AUTHORITY, new.key.as_ref());
    c[config::PENDING..config::PENDING + 32].fill(0);
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
    let minter = next_account_info(it)?;
    if !payer.is_signer || !asset.is_signer {
        return Err(ResidentError::Auth.into());
    }
    check_config(program_id, cfg)?;
    let (terms, treasury_cfg, collection_cfg, name, uri) = {
        let c = cfg.try_borrow_data()?;
        let nl = c[config::NAME_LEN] as usize;
        let ul = c[config::URI_LEN] as usize;
        let name = String::from_utf8(c[config::NAME..config::NAME + nl].to_vec()).map_err(|_| ResidentError::BadData)?;
        let uri = String::from_utf8(c[config::URI..config::URI + ul].to_vec()).map_err(|_| ResidentError::BadData)?;
        (Terms::read(&c)?, rd_key(&c, config::TREASURY)?, rd_key(&c, config::COLLECTION)?, name, uri)
    };
    let price_cfg = terms.price;
    // The sale terms (all set by the config authority; the sale starts closed).
    let (ma, m_bump) = minter_address(program_id, payer.key);
    if *minter.key != ma {
        return Err(ResidentError::BadAddress.into());
    }
    let wallet_minted = if terms.per_wallet > 0 && !minter.data_is_empty() {
        let m = minter.try_borrow_data()?;
        if minter.owner != program_id || m.len() != MINTER_LEN || m[0] != MINTER_MAGIC {
            return Err(ResidentError::NotInitialized.into());
        }
        u16::from_le_bytes([m[33], m[34]])
    } else {
        0
    };
    sale_check(&terms, Clock::get()?.unix_timestamp, wallet_minted)?;
    if name.is_empty() || uri.is_empty() {
        return Err(ResidentError::MetadataNotSet.into());
    }
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
    // 1. the payment (none when the authority set the price to 0)
    if price_cfg > 0 {
        invoke(&system_instruction::transfer(payer.key, treasury.key, price_cfg), &[payer.clone(), treasury.clone(), system.clone()])?;
    }
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
        .name(name)
        .uri(uri)
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
    drop(r);
    // 4. the counts: the collection's, and the payer's when a per-wallet limit is set
    {
        let mut c = cfg.try_borrow_mut_data()?;
        let minted = terms.minted.checked_add(1).ok_or(ResidentError::BadData)?;
        wr(&mut c, config::MINTED, &minted.to_le_bytes());
    }
    if terms.per_wallet > 0 {
        if minter.data_is_empty() {
            create_pda(payer, minter, system, program_id, &[MINTER_SEED, payer.key.as_ref()], m_bump, MINTER_LEN)?;
            let mut m = minter.try_borrow_mut_data()?;
            m[0] = MINTER_MAGIC;
            wr(&mut m, 1, payer.key.as_ref());
            m[MINTER_LEN - 1] = m_bump;
        }
        let mut m = minter.try_borrow_mut_data()?;
        let n = wallet_minted.checked_add(1).ok_or(ResidentError::BadData)?;
        wr(&mut m, 33, &n.to_le_bytes());
    }
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

    fn open_terms() -> Terms {
        Terms { price: 7, max_supply: 3, minted: 0, sale_start: 0, sale_end: 0, per_wallet: 0, open: true }
    }

    #[test]
    fn the_sale_starts_closed_and_refuses_until_the_authority_opens_it() {
        // InitConfig's state: closed, no supply (no value is fixed by the program).
        let closed = Terms { price: 0, max_supply: 0, minted: 0, sale_start: 0, sale_end: 0, per_wallet: 0, open: false };
        assert_eq!(sale_check(&closed, 100, 0), Err(ResidentError::SaleClosed));
        assert_eq!(sale_check(&Terms { open: true, ..closed }, 100, 0), Err(ResidentError::SupplyNotSet));
        assert_eq!(sale_check(&open_terms(), 100, 0), Ok(()));
    }

    #[test]
    fn supply_window_and_per_wallet_limits_are_the_configured_ones() {
        let t = open_terms();
        assert_eq!(sale_check(&Terms { minted: 3, ..t }, 100, 0), Err(ResidentError::SoldOut));
        assert_eq!(sale_check(&Terms { minted: 2, ..t }, 100, 0), Ok(()));
        let w = Terms { sale_start: 50, sale_end: 60, ..t };
        assert_eq!(sale_check(&w, 49, 0), Err(ResidentError::SaleNotStarted));
        assert_eq!(sale_check(&w, 50, 0), Ok(()));
        assert_eq!(sale_check(&w, 60, 0), Err(ResidentError::SaleEnded));
        let p = Terms { per_wallet: 2, ..t };
        assert_eq!(sale_check(&p, 100, 1), Ok(()));
        assert_eq!(sale_check(&p, 100, 2), Err(ResidentError::WalletLimit));
        // No per-wallet limit: the count is not read.
        assert_eq!(sale_check(&t, 100, u16::MAX), Ok(()));
    }

    #[test]
    fn terms_are_consistent_before_they_are_stored() {
        let t = open_terms();
        assert_eq!(terms_check(&t, 4, 9), Ok(()));
        assert_eq!(terms_check(&Terms { max_supply: 1, minted: 2, ..t }, 4, 9), Err(ResidentError::BadTerms));
        assert_eq!(terms_check(&Terms { sale_start: 9, sale_end: 9, ..t }, 4, 9), Err(ResidentError::BadTerms));
        // Opening needs a supply, a name and a URI; a closed sale may be prepared without them.
        assert_eq!(terms_check(&t, 0, 9), Err(ResidentError::MetadataNotSet));
        assert_eq!(terms_check(&Terms { max_supply: 0, ..t }, 4, 9), Err(ResidentError::MetadataNotSet));
        assert_eq!(terms_check(&Terms { open: false, max_supply: 0, ..t }, 0, 0), Ok(()));
    }

    #[test]
    fn metadata_is_bounded_utf8() {
        let mut d = vec![3u8];
        d.extend_from_slice(b"abc");
        d.push(2);
        d.extend_from_slice(b"xy");
        assert_eq!(parse_metadata(&d), Ok((&b"abc"[..], &b"xy"[..])));
        let mut long = vec![(NAME_MAX + 1) as u8];
        long.extend(std::iter::repeat(b'a').take(NAME_MAX + 1));
        long.push(0);
        assert_eq!(parse_metadata(&long), Err(ResidentError::BadTerms));
        assert_eq!(parse_metadata(&[1, 0xff, 0]), Err(ResidentError::BadTerms));
        assert_eq!(parse_metadata(&[3, b'a']), Err(ResidentError::BadData));
    }

    #[test]
    fn the_config_layout_reads_back() {
        let mut c = vec![0u8; CONFIG_LEN];
        wr(&mut c, config::PRICE, &5u64.to_le_bytes());
        wr(&mut c, config::MAX_SUPPLY, &9u64.to_le_bytes());
        wr(&mut c, config::MINTED, &2u64.to_le_bytes());
        wr(&mut c, config::SALE_START, &(-1i64).to_le_bytes());
        wr(&mut c, config::PER_WALLET, &1u16.to_le_bytes());
        c[config::OPEN] = 1;
        let t = Terms::read(&c).unwrap();
        assert_eq!(t, Terms { price: 5, max_supply: 9, minted: 2, sale_start: -1, sale_end: 0, per_wallet: 1, open: true });
        assert_eq!(CONFIG_LEN, 407);
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
