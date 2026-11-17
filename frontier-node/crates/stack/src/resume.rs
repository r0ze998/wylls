//! Restart a persisted human CQ world without recreating its chain, keys or season.
use crate::{
    chain::Chain,
    procs::{Proc, Spec},
    run::{self, RunDir},
    up,
};
use fclient::{addr::Addresses, decode::Season, ports::Account, Address, Keypair, Signer};
use keeper_core::config::KeeperConfig;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

const ORDER: [&str; 6] = [
    "localnet",
    "drand-replay",
    "keeper-a",
    "keeper-b",
    "relay",
    "herald",
];

/// A component that exits after the one-time resume preflight cannot be
/// restarted from memory: its persisted state may have fallen behind the
/// chain or another service. The caller stops the other components on error.
fn require_resumed_component_running(
    name: &str,
    exit: Option<&str>,
    running: bool,
) -> Result<(), String> {
    if exit.is_none() && running {
        return Ok(());
    }
    Err(format!(
        "resumed {name} stopped ({}); refusing automatic restart without a new recovery preflight",
        exit.unwrap_or("no child process")
    ))
}

fn string(v: &Value, k: &str) -> Result<String, String> {
    v[k].as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("missing saved {k}"))
}

/// The small set of on-chain values a saved run must match before its
/// keeper, relay or herald is restarted. The program bytes and keeper
/// journals need separate checks; this is only an identity preflight.
#[derive(Clone, Copy)]
struct ChainSeasonStamp {
    season_id: u64,
    authority: Address,
    program_version: u16,
    params_hash: [u8; 32],
    genesis_ts: i64,
    join_close_bell: u32,
    end_bell: u32,
    continuous_flag: u8,
}

impl ChainSeasonStamp {
    fn from_season(s: &Season) -> Result<Self, String> {
        let cq = s
            .conquest
            .as_ref()
            .ok_or("persisted Season has no conquest parameters")?;
        Ok(Self {
            season_id: s.h.season_id,
            authority: s.authority,
            program_version: s.program_version,
            params_hash: s.params_hash,
            genesis_ts: s.genesis_ts,
            join_close_bell: s.join_close_bell,
            end_bell: s.end_bell,
            continuous_flag: cq.continuous,
        })
    }
}

fn saved_u64(v: &Value, field: &str) -> Result<u64, String> {
    v.as_u64()
        .ok_or_else(|| format!("missing or invalid saved {field}; refusing resume"))
}

fn saved_i64(v: &Value, field: &str) -> Result<i64, String> {
    v.as_i64()
        .ok_or_else(|| format!("missing or invalid saved {field}; refusing resume"))
}

fn read_saved_continuous(v: &Value, field: &str, chain_continuous: bool) -> Result<bool, String> {
    match v {
        Value::Bool(value) => Ok(*value),
        // The field did not exist in finite-world run files before this
        // candidate. The verified finite on-chain mode supplies its value.
        Value::Null if !chain_continuous => Ok(false),
        Value::Null => Err(format!("missing saved {field} for continuous world")),
        _ => Err(format!("invalid saved {field}")),
    }
}

/// Read-only comparison. Missing old finite-mode bits are inferred only
/// after the real Season proves finite; other missing identity data refuse.
fn check_saved_chain(
    state: &Value,
    chain: ChainSeasonStamp,
    expected_id: u64,
    expected_authority: Address,
) -> Result<(), String> {
    use frontier_abi::v2::presets::PROGRAM_VERSION_V2;
    if chain.season_id != expected_id
        || chain.authority != expected_authority
        || chain.program_version < PROGRAM_VERSION_V2
    {
        return Err("persisted Season identity or authority mismatch".into());
    }
    if chain.continuous_flag > 1 {
        return Err("invalid on-chain continuous flag".into());
    }
    let chain_continuous = chain.continuous_flag == 1;
    if chain_continuous != (chain.end_bell == u32::MAX && chain.join_close_bell == u32::MAX) {
        return Err("on-chain continuous flag and end/join limits disagree".into());
    }
    if !chain_continuous && (chain.join_close_bell >= chain.end_bell || chain.end_bell > 4_032) {
        return Err("on-chain finite end/join limits are invalid".into());
    }
    let saved_continuous = read_saved_continuous(
        &state["config"]["continuous"],
        "continuous mode",
        chain_continuous,
    )?;
    let saved_season_continuous = read_saved_continuous(
        &state["season"]["continuous"],
        "Season continuous flag",
        chain_continuous,
    )?;
    if saved_continuous != chain_continuous || saved_season_continuous != chain_continuous {
        return Err("saved and on-chain continuous modes disagree".into());
    }
    let saved_hash = state["season"]["params_hash"]
        .as_str()
        .ok_or("missing saved Season params hash; refusing resume")?;
    let saved_hash: [u8; 32] = hex::decode(saved_hash)
        .map_err(|_| "invalid saved Season params hash")?
        .try_into()
        .map_err(|_| "invalid saved Season params hash length")?;
    if saved_hash != chain.params_hash {
        return Err("saved and on-chain Season params hashes disagree".into());
    }
    if saved_u64(&state["season"]["program_version"], "program version")?
        != u64::from(chain.program_version)
        || saved_i64(&state["season"]["genesis_ts"], "genesis time")? != chain.genesis_ts
        || saved_i64(&state["play"]["genesis_ts"], "play genesis time")? != chain.genesis_ts
        || saved_u64(&state["season"]["join_close_bell"], "join deadline")?
            != u64::from(chain.join_close_bell)
        || saved_u64(&state["season"]["end_bell"], "end bell")? != u64::from(chain.end_bell)
    {
        return Err("saved and on-chain Season parameters disagree".into());
    }
    Ok(())
}

/// The localnet records a LoaderV3 Program as tag 2 + its derived
/// ProgramData address, and ProgramData as a 45-byte header followed by
/// the exact deployed ELF and zero padding to max_len. Refuse any unknown
/// layout or nonzero padding instead of guessing the executable length.
fn check_loader_program(
    program: Address,
    pd_address: Address,
    expected_authority: Address,
    program_account: &Account,
    pd_account: &Account,
    saved_so: &[u8],
) -> Result<(), String> {
    let bad = || "saved .so and on-chain LoaderV3 ProgramData disagree".to_string();
    let loader = fclient::addr::address(fclient::abi::LOADER_V3);
    let expected_pd = fclient::addr::programdata(&program);
    if pd_address != expected_pd
        || program_account.owner != loader
        || !program_account.executable
        || program_account.data.len() != 36
        || program_account.data[..4] != [2, 0, 0, 0]
        || program_account.data[4..36] != expected_pd.as_ref()[..]
        || pd_account.owner != loader
        || pd_account.executable
        || pd_account.data.len() < 45
        || pd_account.data[..4] != [3, 0, 0, 0]
        || saved_so.get(..6) != Some(b"\x7fELF\x02\x01".as_slice())
    {
        return Err(bad());
    }
    if pd_account.data[12] != 1 || pd_account.data[13..45] != expected_authority.as_ref()[..] {
        return Err(bad());
    }
    let end = 45usize.checked_add(saved_so.len()).ok_or_else(bad)?;
    if pd_account.data.get(45..end) != Some(saved_so)
        || !pd_account.data[end..].iter().all(|b| *b == 0)
    {
        return Err(bad());
    }
    Ok(())
}

/// Fixed offsets from permutation-prize/src/lib.rs::pool. Keep this check
/// read-only and independent of the program crate used to build prize.so.
mod prize_pool {
    pub const SIZE: usize = 640;
    pub const MAGIC: &[u8; 8] = b"WYPRPOOL";
    pub const BUMP: usize = 8;
    pub const VAULT_BUMP: usize = 9;
    pub const STATE: usize = 10;
    pub const DECIMALS: usize = 11;
    pub const MODE: usize = 13;
    pub const SEASON_ID: usize = 16;
    pub const GAME_PROGRAM: usize = 24;
    pub const SEASON: usize = 56;
    pub const OPERATOR: usize = 88;
    pub const MINT: usize = 120;
    pub const VAULT: usize = 152;
    pub const FEE: usize = 184;
    pub const OPS_BPS: usize = 192;
    pub const EXPECTED_KEEPS: usize = 194;
    pub const PARAMS_HASH: usize = 200;
    pub const ENTRIES: usize = 232;
    pub const COLLECTED: usize = 240;
    pub const PRIZE: usize = 248;
    pub const OPS: usize = 256;
    pub const OPS_WITHDRAWN: usize = 264;
    pub const CLAIMED: usize = 272;
    pub const END_BELL: usize = 456;
}

struct SavedPrize {
    program: Address,
    so_sha256: [u8; 32],
    pool: Address,
    vault: Address,
    mint: Address,
    faucet: Address,
    pool_bump: u8,
    vault_bump: u8,
    decimals: u8,
    fee: u64,
    ops_bps: u16,
    expected_keeps: u16,
    params_hash: [u8; 32],
}

fn prize_address(v: &Value, key: &str) -> Result<Address, String> {
    string(v, key)?
        .parse()
        .map_err(|_| format!("invalid saved prize {key}; refusing resume"))
}

fn saved_prize(state: &Value, game: Address, season_id: u64) -> Result<SavedPrize, String> {
    let prize = &state["prize"];
    let config = &state["config"]["prize"];
    if !prize.is_object() || !config.is_object() || prize["test_assets_only"] != true {
        return Err("incomplete saved prize configuration; refusing resume".into());
    }
    let program = prize_address(prize, "program")?;
    let so_sha256: [u8; 32] = hex::decode(string(prize, "so_sha256")?)
        .map_err(|_| "invalid saved prize.so hash")?
        .try_into()
        .map_err(|_| "invalid saved prize.so hash length")?;
    let pool = prize_address(prize, "pool")?;
    let vault = prize_address(prize, "vault")?;
    let mint = prize_address(prize, "mint")?;
    let faucet = prize_address(prize, "faucet")?;
    let (expected_pool, pool_bump) = Address::find_program_address(
        &[b"pool", game.as_ref(), &season_id.to_le_bytes()],
        &program,
    );
    let (expected_vault, vault_bump) =
        Address::find_program_address(&[b"vault", pool.as_ref()], &program);
    if pool != expected_pool || vault != expected_vault {
        return Err("saved prize pool or vault PDA changed; refusing resume".into());
    }
    let decimals: u8 = saved_u64(&prize["decimals"], "prize decimals")?
        .try_into()
        .map_err(|_| "invalid saved prize decimals")?;
    let fee = saved_u64(&prize["entry_fee"], "prize entry fee")?;
    let ops_bps: u16 = saved_u64(&prize["ops_bps"], "prize ops bps")?
        .try_into()
        .map_err(|_| "invalid saved prize ops bps")?;
    let expected_keeps: u16 = saved_u64(&prize["expected_keeps"], "prize keeps")?
        .try_into()
        .map_err(|_| "invalid saved prize keeps")?;
    if decimals != crate::prize::DECIMALS
        || fee == 0
        || ops_bps > 10_000
        || config["entry_fee"].as_u64() != Some(fee)
        || config["ops_bps"].as_u64() != Some(u64::from(ops_bps))
        || config["keeps"].as_u64() != Some(u64::from(expected_keeps))
    {
        return Err("saved prize payment configuration changed; refusing resume".into());
    }
    let params_hash: [u8; 32] = hex::decode(string(prize, "params_hash")?)
        .map_err(|_| "invalid saved prize params hash")?
        .try_into()
        .map_err(|_| "invalid saved prize params hash length")?;
    Ok(SavedPrize {
        program,
        so_sha256,
        pool,
        vault,
        mint,
        faucet,
        pool_bump,
        vault_bump,
        decimals,
        fee,
        ops_bps,
        expected_keeps,
        params_hash,
    })
}

/// Check the actual Pool, SPL Token Vault and Mint on the paused localnet.
/// Donations can increase the vault balance, so require enough for recorded
/// unpaid rights without equating its balance to collected fees.
fn check_prize_accounts(
    saved: &SavedPrize,
    game: Address,
    season_id: u64,
    season: Address,
    authority: Address,
    end_bell: u32,
    [pool, vault, mint]: [&Account; 3],
) -> Result<(), String> {
    use prize_pool as p;
    let bad = || "saved prize and on-chain pool/vault/mint disagree; refusing resume".to_string();
    let token: Address = crate::prize::TOKEN_PROGRAM
        .parse()
        .map_err(|_| "invalid SPL Token program id")?;
    let d = &pool.data;
    if pool.owner != saved.program
        || pool.executable
        || d.len() != p::SIZE
        || &d[..8] != p::MAGIC
        || d[p::BUMP] != saved.pool_bump
        || d[p::VAULT_BUMP] != saved.vault_bump
        || d[p::STATE] > 2
        || (d[p::STATE] == 2 && !matches!(d[p::MODE], 1 | 2))
        || (d[p::STATE] != 2 && d[p::MODE] != 0)
        || d[p::DECIMALS] != saved.decimals
        || d[p::SEASON_ID..p::SEASON_ID + 8] != season_id.to_le_bytes()
        || d[p::GAME_PROGRAM..p::GAME_PROGRAM + 32] != game.as_ref()[..]
        || d[p::SEASON..p::SEASON + 32] != season.as_ref()[..]
        || d[p::OPERATOR..p::OPERATOR + 32] != authority.as_ref()[..]
        || d[p::MINT..p::MINT + 32] != saved.mint.as_ref()[..]
        || d[p::VAULT..p::VAULT + 32] != saved.vault.as_ref()[..]
        || d[p::FEE..p::FEE + 8] != saved.fee.to_le_bytes()
        || d[p::OPS_BPS..p::OPS_BPS + 2] != saved.ops_bps.to_le_bytes()
        || d[p::EXPECTED_KEEPS..p::EXPECTED_KEEPS + 2] != saved.expected_keeps.to_le_bytes()
        || d[p::PARAMS_HASH..p::PARAMS_HASH + 32] != saved.params_hash
        || d[p::END_BELL..p::END_BELL + 4] != end_bell.to_le_bytes()
    {
        return Err(bad());
    }
    // SPL Token Mint (82 bytes): authority option/key, supply, decimals,
    // initialized flag and freeze authority option.
    if mint.owner != token
        || mint.executable
        || mint.data.len() != 82
        || mint.data[..4] != [1, 0, 0, 0]
        || mint.data[4..36] != saved.faucet.as_ref()[..]
        || mint.data[44] != saved.decimals
        || mint.data[45] != 1
        || mint.data[46..50] != [0; 4]
    {
        return Err(bad());
    }
    // SPL Token Account (165 bytes): mint, authority, amount, optional
    // delegate/native/close authorities, and initialized state.
    if vault.owner != token
        || vault.executable
        || vault.data.len() != 165
        || vault.data[..32] != saved.mint.as_ref()[..]
        || vault.data[32..64] != saved.pool.as_ref()[..]
        || vault.data[72..76] != [0; 4]
        || vault.data[108] != 1
        || vault.data[109..113] != [0; 4]
        || vault.data[129..133] != [0; 4]
    {
        return Err(bad());
    }
    let number = |at: usize| u64::from_le_bytes(d[at..at + 8].try_into().expect("pool length"));
    let entries = u64::from(u32::from_le_bytes(
        d[p::ENTRIES..p::ENTRIES + 4]
            .try_into()
            .expect("pool length"),
    ));
    let collected = number(p::COLLECTED);
    let prize = number(p::PRIZE);
    let ops = number(p::OPS);
    let withdrawn = number(p::OPS_WITHDRAWN);
    let claimed = number(p::CLAIMED);
    let vault_amount = u64::from_le_bytes(vault.data[64..72].try_into().expect("vault length"));
    let unpaid = prize
        .checked_sub(claimed)
        .and_then(|x| ops.checked_sub(withdrawn).and_then(|y| x.checked_add(y)));
    if entries.checked_mul(saved.fee) != Some(collected)
        || prize.checked_add(ops) != Some(collected)
        || unpaid.is_none_or(|amount| vault_amount < amount)
    {
        return Err(bad());
    }
    Ok(())
}

/// A saved world must never silently replace a lost journal, secret, or
/// sponsorship state with a new empty one. These checks run before localnet
/// or any service starts. They cannot prove a cross-service checkpoint or
/// recover a send whose outcome was never durably recorded.
fn existing_file(path: &Path, label: &str) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| format!("missing saved {label}; refusing resume"))?;
    if !meta.file_type().is_file() || meta.len() == 0 {
        return Err(format!("invalid saved {label}; refusing resume"));
    }
    Ok(())
}

fn saved_seed(path: &Path, label: &str) -> Result<[u8; 32], String> {
    existing_file(path, label)?;
    let encoded = std::fs::read_to_string(path)
        .map_err(|_| format!("unreadable saved {label}; refusing resume"))?;
    hex::decode(encoded.trim())
        .map_err(|_| format!("invalid saved {label}; refusing resume"))?
        .try_into()
        .map_err(|_| format!("invalid saved {label} length; refusing resume"))
}

fn saved_token(path: &Path, label: &str) -> Result<String, String> {
    existing_file(path, label)?;
    let encoded = std::fs::read_to_string(path)
        .map_err(|_| format!("unreadable saved {label}; refusing resume"))?;
    if hex::decode(encoded.trim()).is_ok_and(|b| b.len() == 24) {
        Ok(encoded.trim().to_string())
    } else {
        Err(format!("invalid saved {label}; refusing resume"))
    }
}

fn saved_arg<'a>(spec: &'a Spec, flag: &str) -> Result<&'a str, String> {
    let values: Vec<&str> = spec
        .args
        .windows(2)
        .filter(|w| w[0] == flag)
        .map(|w| w[1].as_str())
        .collect();
    match values.as_slice() {
        [value] if !value.starts_with("--") => Ok(value),
        _ => Err(format!(
            "missing or ambiguous saved {flag}; refusing resume"
        )),
    }
}

fn saved_path_arg(spec: &Spec, flag: &str, expected: &Path) -> Result<(), String> {
    if saved_arg(spec, flag)? == expected.to_str().ok_or("non-UTF8 run path")? {
        Ok(())
    } else {
        Err(format!("saved {flag} path changed; refusing resume"))
    }
}

/// Conservative source compatibility marker for a saved relay script and
/// its imported config. It does not authenticate either source file.
fn relay_source_supports_resume(server: &str, config: &str) -> bool {
    server.contains("requireExistingRelayFiles(cfg);")
        && config.contains("'require-existing-state': 'requireExistingState'")
        && config.contains("export function requireExistingRelayFiles(cfg)")
}

/// SQLite verifies its main database together with any active WAL. A lost
/// WAL whose transactions were never checkpointed cannot be reconstructed;
/// this is a structural check, not a complete history proof.
fn check_keeper_journal(path: &Path) -> Result<(), String> {
    existing_file(path, "keeper journal")?;
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "unreadable saved keeper journal; refusing resume".to_string())?;
    let check: String = db
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|_| "invalid saved keeper journal; refusing resume".to_string())?;
    if check != "ok" {
        return Err("corrupt saved keeper journal; refusing resume".into());
    }
    for sql in [
        "SELECT sig, kind, object_key, first_valid_slot, status, fee FROM attempts LIMIT 0",
        "SELECT host, bell, plain, salt FROM plaintexts LIMIT 0",
        "SELECT host, bell, track, holding, transit_slot, plain, salt, ct_hash FROM owner_material LIMIT 0",
        "SELECT name, value FROM cursor LIMIT 0",
        "SELECT slot_key, state FROM claims LIMIT 0",
        "SELECT pool, i, address FROM payers LIMIT 0",
        "SELECT slot, event FROM conquest LIMIT 0",
    ] {
        db.prepare(sql)
            .map_err(|_| "incomplete saved keeper journal schema; refusing resume".to_string())?;
    }
    let unknown_fee: i64 = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM attempts WHERE fee IS NULL LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "unreadable saved keeper fee history; refusing resume".to_string())?;
    if unknown_fee != 0 {
        return Err("saved keeper journal has unknown fees; refusing resume".into());
    }
    Ok(())
}

fn check_relay_state(
    path: &Path,
    game: Address,
    season: u64,
    prize: &Value,
    master_seed: &[u8; 32],
    invite_secret: &[u8; 32],
) -> Result<(), String> {
    existing_file(path, "relay state")?;
    let bytes = std::fs::read(path)
        .map_err(|_| "unreadable saved relay state; refusing resume".to_string())?;
    let state: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "invalid saved relay state; refusing resume".to_string())?;
    let identity = &state["runIdentity"];
    let game_id = game.to_string();
    let season_id = season.to_string();
    let gate = prize["join_gate"].as_str();
    let faucet = prize["faucet"].as_str();
    let prize_program = prize["program"].as_str();
    let prize_mint = prize["mint"].as_str();
    let master_hash = hex::encode(Sha256::digest(master_seed));
    let invite_hash = hex::encode(Sha256::digest(invite_secret));
    if !state.is_object()
        || !state["quota"].is_object()
        || !state["invitesUsed"].is_object()
        || (!state["faucet"].is_null() && !state["faucet"].is_object())
        || (prize.is_object() && !state["faucet"].is_object())
        || identity["programId"].as_str() != Some(game_id.as_str())
        || identity["seasonId"].as_str() != Some(season_id.as_str())
        || identity["gate"].as_str() != gate
        || identity["faucet"].as_str() != faucet
        || identity["prizeProgram"].as_str() != prize_program
        || identity["prizeMint"].as_str() != prize_mint
        || identity["masterSeedSha256"].as_str() != Some(master_hash.as_str())
        || identity["inviteSecretSha256"].as_str() != Some(invite_hash.as_str())
    {
        return Err("incomplete saved relay state; refusing resume".into());
    }
    Ok(())
}

fn check_saved_keypair(
    path: &Path,
    seed_path: &Path,
    expected: &str,
    label: &str,
) -> Result<(), String> {
    existing_file(path, label)?;
    let bytes =
        std::fs::read(path).map_err(|_| format!("unreadable saved {label}; refusing resume"))?;
    let bytes: Vec<u8> = serde_json::from_slice(&bytes)
        .map_err(|_| format!("invalid saved {label}; refusing resume"))?;
    let expected: Address = expected
        .parse()
        .map_err(|_| format!("invalid saved {label} address; refusing resume"))?;
    let seed = saved_seed(seed_path, label)?;
    if !keypair_matches(&bytes, seed, expected) {
        return Err(format!("saved {label} identity changed; refusing resume"));
    }
    Ok(())
}

/// Pure comparison: tests can use fixed bytes in memory without writing a
/// test key file, while the resume path reads only pre-existing files.
fn keypair_matches(bytes: &[u8], seed: [u8; 32], expected: Address) -> bool {
    let pair = Keypair::new_from_array(seed);
    bytes.len() == 64 && pair.pubkey() == expected && pair.to_bytes().as_slice() == bytes
}

fn check_recovery_files(
    rd: &RunDir,
    state: &Value,
    specs: &BTreeMap<String, Spec>,
) -> Result<(), String> {
    let game: Address = string(state, "program")?
        .parse()
        .map_err(|_| "invalid saved program")?;
    let season = saved_u64(&state["season_id"], "season id")?;
    let operator =
        Keypair::new_from_array(saved_seed(&rd.path("keys/operator.seed"), "operator seed")?);
    if operator.pubkey().to_string() != string(state, "authority")? {
        return Err("saved operator identity changed; refusing resume".into());
    }
    if specs.contains_key("keeper-b") != state["keepers"]["b"].is_object() {
        return Err("saved keeper-b identity or process spec is missing; refusing resume".into());
    }
    for name in ["keeper-a", "keeper-b"] {
        let Some(spec) = specs.get(name) else {
            continue;
        };
        let config_path = rd.path(&format!("{name}/keeper.toml"));
        saved_path_arg(spec, "--config", &config_path)?;
        existing_file(&config_path, "keeper config")?;
        let config_text = std::fs::read_to_string(&config_path)
            .map_err(|_| "unreadable saved keeper config; refusing resume".to_string())?;
        let config = KeeperConfig::from_toml(&config_text)
            .map_err(|_| "invalid saved keeper config; refusing resume".to_string())?;
        let journal = rd.path(&format!("{name}/keeper.journal.sqlite"));
        let token = rd.path(&format!("{name}/keeper.token"));
        let seed = rd.path(&format!("{name}/keeper.seed"));
        let beneficiary = rd.path(&format!("{name}/beneficiary.key"));
        let rpc = format!(
            "http://127.0.0.1:{}",
            saved_u64(&state["ports"]["localnet"], "RPC port")?
        );
        if config.program != game
            || config.season_id != season
            || config.rpc != vec![rpc]
            || config.journal.as_deref() != Some(journal.as_path())
            || config.token_file.as_deref() != Some(token.as_path())
            || config.master_seed_file.as_deref() != Some(seed.as_path())
            || config.beneficiary_key_file.as_deref() != Some(beneficiary.as_path())
        {
            return Err(format!(
                "saved {name} config identity changed; refusing resume"
            ));
        }
        check_keeper_journal(&journal)?;
        saved_seed(&seed, "keeper seed")?;
        let beneficiary_key =
            Keypair::new_from_array(saved_seed(&beneficiary, "keeper beneficiary")?);
        let which = if name == "keeper-a" { "a" } else { "b" };
        if beneficiary_key.pubkey() != config.beneficiary
            || beneficiary_key.pubkey().to_string()
                != string(&state["keepers"][which], "beneficiary")?
        {
            return Err(format!("saved {name} beneficiary changed; refusing resume"));
        }
        saved_token(&token, "keeper token")?;
    }
    let relay = specs.get("relay").ok_or("missing saved relay spec")?;
    let relay_seed = rd.path("relay/relay-master.seed");
    let invite_secret = rd.path("relay/invite.secret");
    let relay_state = rd.path("relay/relay-state.json");
    saved_path_arg(relay, "--master-seed-file", &relay_seed)?;
    saved_path_arg(relay, "--invite-secret-file", &invite_secret)?;
    saved_path_arg(relay, "--state-file", &relay_state)?;
    if saved_arg(relay, "--program")? != game.to_string()
        || saved_arg(relay, "--season")? != season.to_string()
    {
        return Err("saved relay identity changed; refusing resume".into());
    }
    let master_seed = saved_seed(&relay_seed, "relay master seed")?;
    let invite_secret = saved_seed(&invite_secret, "relay invite secret")?;
    saved_token(&rd.path("relay/operator.token"), "relay operator token")?;
    let prize = &state["prize"];
    check_relay_state(
        &relay_state,
        game,
        season,
        prize,
        &master_seed,
        &invite_secret,
    )?;
    let gated = relay.args.iter().any(|x| x == "--gate-key-file");
    let faucet = relay.args.iter().any(|x| x == "--faucet-key-file");
    if gated != prize.is_object() || faucet != prize.is_object() {
        return Err("saved prize relay configuration changed; refusing resume".into());
    }
    if prize.is_object() {
        let gate_file = rd.path("relay/gate-key.json");
        let faucet_file = rd.path("relay/faucet-key.json");
        saved_path_arg(relay, "--gate-key-file", &gate_file)?;
        saved_path_arg(relay, "--faucet-key-file", &faucet_file)?;
        if saved_arg(relay, "--prize-program")? != string(prize, "program")?
            || saved_arg(relay, "--prize-mint")? != string(prize, "mint")?
        {
            return Err("saved prize program identity changed; refusing resume".into());
        }
        check_saved_keypair(
            &gate_file,
            &rd.path("relay/gate.seed"),
            &string(prize, "join_gate")?,
            "join gate key",
        )?;
        check_saved_keypair(
            &faucet_file,
            &rd.path("relay/faucet.seed"),
            &string(prize, "faucet")?,
            "test faucet key",
        )?;
    }
    Ok(())
}

fn specs(rd: &RunDir, state: &Value) -> Result<BTreeMap<String, Spec>, String> {
    if state["config"]["continuous"] == true {
        return Err("resume of continuous worlds is not supported until saved bots and the chain flag are verified".into());
    }
    if state["config"]["conquest"] != true || state["config"]["bots"].as_u64() != Some(0) {
        return Err("resume is for persisted human CQ worlds with bots=0".into());
    }
    if !up::live_components(state).is_empty() {
        return Err("world still has running components; stop it with down before resume".into());
    }
    if state["play"]["genesis_ts"].as_i64().is_none() || !rd.path("localnet/ledger.wal").is_file() {
        return Err("world setup was not completed or its ledger is missing".into());
    }
    let program = string(&state["so"], "path")?;
    let bytes = std::fs::read(&program).map_err(|e| format!("saved program: {e}"))?;
    if hex::encode(Sha256::digest(&bytes)) != string(&state["so"], "sha256")? {
        return Err("saved program hash changed; refusing to resume with another program".into());
    }
    for value in state["ports"]
        .as_object()
        .ok_or("missing saved ports")?
        .values()
    {
        if let Some(port) = value.as_u64() {
            crate::ports::check(port as u16)?;
        }
    }
    let mut out = BTreeMap::new();
    for name in ORDER {
        let v = &state["components"][name]["spec"];
        if v.is_null() && name == "keeper-b" {
            continue;
        }
        let mut spec = Spec {
            name: name.into(),
            program: PathBuf::from(string(v, "program")?),
            args: v["args"]
                .as_array()
                .ok_or("missing saved arguments")?
                .iter()
                .map(|x| {
                    x.as_str()
                        .map(str::to_owned)
                        .ok_or("invalid saved argument".to_string())
                })
                .collect::<Result<_, _>>()?,
            env: vec![],
            cwd: PathBuf::from(string(v, "cwd")?),
            log: PathBuf::from(string(v, "log")?),
            finishes: false,
        };
        if !spec.program.is_file() {
            return Err(format!("{} is missing", spec.program.display()));
        }
        if name != "relay" {
            run::check_native_binary(rd, &spec.program)?;
        }
        if name == "keeper-a" || name == "keeper-b" {
            if !up::keeper_accepts(&spec.program, "--require-existing-journal") {
                return Err(format!(
                    "saved {name} binary cannot require its journal; refusing resume"
                ));
            }
            // The keeper must repeat this check at its own open to close a
            // deletion race after the stack's read-only SQLite preflight.
            if !spec
                .args
                .iter()
                .any(|arg| arg == "--require-existing-journal")
            {
                spec.args.push("--require-existing-journal".into());
            }
        }
        if name == "relay" {
            // The saved relay path is normally the versioned server.mjs.
            // This source marker is a conservative compatibility check, not
            // proof of its runtime behavior; the relay repeats file checks.
            let script = spec.args.first().ok_or("missing saved relay script")?;
            let source = std::fs::read_to_string(script)
                .map_err(|_| "saved relay script cannot be read; refusing resume".to_string())?;
            let config_path = Path::new(script)
                .parent()
                .ok_or("saved relay script has no parent directory")?
                .join("config.mjs");
            let config_source = std::fs::read_to_string(&config_path)
                .map_err(|_| "saved relay config cannot be read; refusing resume".to_string())?;
            if !relay_source_supports_resume(&source, &config_source) {
                return Err(
                    "saved relay source cannot enforce restored state; refusing resume".into(),
                );
            }
            let token = std::fs::read_to_string(rd.path("relay/operator.token"))
                .map_err(|e| e.to_string())?;
            spec.env
                .push(("FRONTIER_OPERATOR_TOKEN".into(), token.trim().into()));
            // A second check in the relay itself closes a deletion race
            // between this preflight and its process start.
            if !spec
                .args
                .iter()
                .any(|arg| arg == "--require-existing-state")
            {
                spec.args.push("--require-existing-state".into());
            }
        }
        if name == "localnet" && !spec.args.iter().any(|x| x == "--start-paused") {
            spec.args.push("--start-paused".into());
        }
        out.insert(name.into(), spec);
    }
    check_recovery_files(rd, state, &out)?;
    Ok(out)
}
fn save(rd: &RunDir, state: &mut Value, procs: &BTreeMap<String, Proc>, phase: &str) {
    for (name, p) in procs {
        state["components"][name] = json!({"pid": p.pid,"start_stamp":p.start_stamp,"starts":p.starts,"done":p.done,"last_exit":p.last_exit,"spec":p.spec.to_json()});
    }
    state["phase"] = json!(phase);
    state["supervisor_pid"] = json!(std::process::id());
    state["supervisor_start_stamp"] = json!(crate::procs::start_stamp(std::process::id()));
    state["supervisor_command"] = json!(crate::procs::command_of(std::process::id()));
    state["updated_wall_ms"] = json!(run::wall_ms());
    let _ = rd.save_state(state);
}
async fn run(
    rd: &RunDir,
    state: &mut Value,
    procs: &mut BTreeMap<String, Proc>,
    saved: BTreeMap<String, Spec>,
    start_paused: bool,
) -> Result<(), String> {
    let program: Address = string(state, "program")?
        .parse()
        .map_err(|_| "invalid saved program")?;
    let season = state["season_id"].as_u64().ok_or("missing season id")?;
    let rpc = format!(
        "http://127.0.0.1:{}",
        state["ports"]["localnet"]
            .as_u64()
            .ok_or("missing RPC port")?
    );
    let chain = Chain::new(&rpc, program);
    let addrs = Addresses::new(program, season);
    // Read only: a missing authority key must never be silently replaced.
    let seed = std::fs::read_to_string(rd.path("keys/operator.seed")).map_err(|e| e.to_string())?;
    let seed: [u8; 32] = hex::decode(seed.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid authority seed")?;
    let authority = Keypair::new_from_array(seed);
    let prize = if state["prize"].is_null() {
        if !state["config"]["prize"].is_null() {
            return Err(
                "saved prize configuration has no initialized pool; refusing resume".into(),
            );
        }
        None
    } else {
        Some(saved_prize(state, program, season)?)
    };
    let prize_so = if let Some(prize) = &prize {
        let path = rd.path("prize.so");
        existing_file(&path, "prize.so")?;
        let bytes = std::fs::read(&path).map_err(|_| "unreadable saved prize.so")?;
        if Sha256::digest(&bytes).as_slice() != prize.so_sha256 {
            return Err("saved prize.so differs from pinned hash; refusing resume".into());
        }
        let localnet = saved.get("localnet").ok_or("missing saved localnet spec")?;
        let expected = format!(
            "{}={}:{}@{}",
            prize.program,
            path.display(),
            fclient::fees::deploy_max_len(bytes.len() as u64),
            authority.pubkey()
        );
        let prefix = format!("{}=", prize.program);
        let mut deployments = localnet
            .args
            .windows(2)
            .filter(|args| args[0] == "--program" && args[1].starts_with(&prefix))
            .map(|args| args[1].as_str());
        if deployments.next() != Some(expected.as_str()) || deployments.next().is_some() {
            return Err("saved localnet prize deployment spec changed; refusing resume".into());
        }
        let program_key = Keypair::new_from_array(saved_seed(
            &rd.path("keys/prize-program.seed"),
            "prize program seed",
        )?);
        let mint_key = Keypair::new_from_array(saved_seed(
            &rd.path("keys/prize-mint.seed"),
            "prize mint seed",
        )?);
        if program_key.pubkey() != prize.program || mint_key.pubkey() != prize.mint {
            return Err("saved prize key identity changed; refusing resume".into());
        }
        Some(bytes)
    } else {
        None
    };
    let mut checked_season = None;
    for name in ORDER {
        let Some(spec) = saved.get(name) else {
            continue;
        };
        let mut p = Proc::new(spec.clone());
        p.start()?;
        procs.insert(name.into(), p);
        if name == "localnet" {
            chain.wait_healthy(Duration::from_secs(180)).await?;
            if !chain.status().await?.paused {
                return Err("localnet is not paused during resume preflight".into());
            }
            // Only localnet is running. Check its actual owner, address and
            // saved identity before starting any keeper or public service.
            let account = chain
                .accounts(&[addrs.season])
                .await?
                .into_iter()
                .next()
                .flatten()
                .ok_or("persisted Season is missing")?;
            if account.owner != program {
                return Err("persisted Season owner mismatch".into());
            }
            let season_account = Season::decode(&account.data)
                .map_err(|e| format!("persisted Season cannot be decoded: {e:?}"))?;
            let stamp = ChainSeasonStamp::from_season(&season_account)?;
            check_saved_chain(state, stamp, season, authority.pubkey())?;
            let saved_so = std::fs::read(string(&state["so"], "path")?)
                .map_err(|e| format!("saved program: {e}"))?;
            if hex::encode(Sha256::digest(&saved_so)) != string(&state["so"], "sha256")? {
                return Err("saved program changed before ProgramData check".into());
            }
            let pd_address = fclient::addr::programdata(&program);
            let mut deployed = chain.accounts(&[program, pd_address]).await?.into_iter();
            let program_account = deployed
                .next()
                .flatten()
                .ok_or("deployed program account is missing")?;
            let pd_account = deployed
                .next()
                .flatten()
                .ok_or("deployed ProgramData account is missing")?;
            check_loader_program(
                program,
                pd_address,
                authority.pubkey(),
                &program_account,
                &pd_account,
                &saved_so,
            )?;
            if let (Some(prize), Some(prize_so)) = (&prize, &prize_so) {
                if std::fs::read(rd.path("prize.so")).map_err(|_| "unreadable saved prize.so")?
                    != *prize_so
                {
                    return Err("saved prize.so changed during resume preflight".into());
                }
                let prize_pd = fclient::addr::programdata(&prize.program);
                let mut accounts = chain
                    .accounts(&[prize.program, prize_pd, prize.pool, prize.vault, prize.mint])
                    .await?
                    .into_iter();
                let mut required = |label: &str| {
                    accounts
                        .next()
                        .flatten()
                        .ok_or_else(|| format!("on-chain prize {label} is missing"))
                };
                let prize_program = required("program")?;
                let prize_program_data = required("ProgramData")?;
                let pool = required("pool")?;
                let vault = required("vault")?;
                let mint = required("mint")?;
                check_loader_program(
                    prize.program,
                    prize_pd,
                    authority.pubkey(),
                    &prize_program,
                    &prize_program_data,
                    prize_so,
                )?;
                check_prize_accounts(
                    prize,
                    program,
                    season,
                    addrs.season,
                    authority.pubkey(),
                    season_account.end_bell,
                    [&pool, &vault, &mint],
                )?;
            }
            checked_season = Some(season_account);
        }
        save(rd, state, procs, "resuming");
    }
    let s = checked_season.ok_or("persisted Season was not checked before resume")?;
    if !start_paused {
        chain.resume().await?;
    }
    save(rd, state, procs, "running");
    rd.event(
        None,
        "resume",
        json!({"season":season,"program":program.to_string()}),
    );
    eprintln!(
        "frontier-stack: resumed persisted season {season}; player state and game clock preserved"
    );
    let mut ended = s.status >= 4;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        for name in ORDER {
            let Some(p) = procs.get_mut(name) else {
                continue;
            };
            let exit = p.poll_exit();
            require_resumed_component_running(name, exit.as_deref(), p.running())?;
        }
        if !ended {
            let clock = chain.status().await?;
            let now = clock.now;
            if !clock.paused && now >= s.genesis_ts + s.end_bell as i64 * s.bell_secs as i64 {
                let result = up::end_season_until_done(&rpc, program, &addrs, &authority).await;
                ended = result["ok"] == true;
                rd.event(Some(now), "end-season", result);
            }
        }
        save(rd, state, procs, "running");
    }
}

pub async fn resume(rd: &RunDir, start_paused: bool) -> i32 {
    let _lock = match rd.lock() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("frontier-stack: {e}");
            return 2;
        }
    };
    let mut state = match rd.load_state() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("frontier-stack: {e}");
            return 2;
        }
    };
    // A stopped file set is usable once only. Verify and durably consume its
    // seal before opening SQLite or starting localnet. This never enables
    // continuous worlds or bot fleets, whose in-memory history is incomplete.
    if state["config"]["continuous"] == true || state["config"]["bots"].as_u64() != Some(0) {
        eprintln!("frontier-stack: continuous or bot world recovery is not verified");
        return 2;
    }
    if let Err(e) = crate::recovery_seal::verify_and_consume(rd, &state) {
        eprintln!("frontier-stack: {e}");
        return 2;
    }
    let saved = match specs(rd, &state) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("frontier-stack: {e}");
            return 2;
        }
    };
    let mut procs = BTreeMap::new();
    let result = tokio::select! { r = run(rd,&mut state,&mut procs,saved,start_paused) => r, _ = tokio::signal::ctrl_c() => Ok(()) };
    for name in ORDER.into_iter().rev() {
        if let Some(p) = procs.get_mut(name) {
            p.stop(Duration::from_secs(10));
        }
    }
    if let Err(e) = &result {
        eprintln!("frontier-stack: resume failed: {e}");
        state["error"] = json!(e);
    }
    save(
        rd,
        &mut state,
        &procs,
        if result.is_ok() {
            "interrupted"
        } else {
            "failed"
        },
    );
    if result.is_ok() {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_services_never_restart_after_an_exit_or_missing_child() {
        for name in ORDER {
            assert!(require_resumed_component_running(name, None, true).is_ok());
            for (exit, running) in [
                (Some("exit 1"), false),
                (Some("exit 0"), false),
                (None, false),
            ] {
                let error = require_resumed_component_running(name, exit, running).unwrap_err();
                assert!(error.contains(name));
                assert!(error.contains("refusing automatic restart"));
            }
        }
    }

    #[test]
    fn relay_resume_requires_both_script_and_config_support() {
        let server = "requireExistingRelayFiles(cfg);";
        let config = "'require-existing-state': 'requireExistingState'; export function requireExistingRelayFiles(cfg) {}";
        assert!(relay_source_supports_resume(server, config));
        assert!(!relay_source_supports_resume("old server", config));
        assert!(!relay_source_supports_resume(server, "old config"));
    }

    #[test]
    fn recovery_preflight_refuses_missing_corrupt_and_wrong_world_state() {
        let dir = std::env::temp_dir().join(format!(
            "frontier-resume-preflight-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("keeper.journal.sqlite");
        assert!(check_keeper_journal(&db_path).is_err());
        std::fs::write(&db_path, b"not a SQLite journal").unwrap();
        assert!(check_keeper_journal(&db_path).is_err());
        std::fs::remove_file(&db_path).unwrap();
        {
            let journal = keeper_core::journal::Journal::open(&db_path).unwrap();
            drop(journal);
        }
        assert!(check_keeper_journal(&db_path).is_ok());
        {
            let db = Connection::open(&db_path).unwrap();
            db.execute(
                "INSERT INTO attempts(sig, kind, object_key, class, payer, bid_milli, cu_limit, \
                 first_valid_slot, sent_slot, status) VALUES('s', 'reveal', 'o', 'D', 'p', 1, 1, 1, 1, 'sent')",
                [],
            )
            .unwrap();
        }
        assert!(check_keeper_journal(&db_path)
            .unwrap_err()
            .contains("unknown fees"));

        let game = Address::new_from_array([7; 32]);
        let seed = [3u8; 32];
        let invite = [4u8; 32];
        let state_path = dir.join("relay-state.json");
        let prize = Value::Null;
        assert!(check_relay_state(&state_path, game, 8, &prize, &seed, &invite).is_err());
        let mut state = json!({
            "runIdentity": {
                "programId": game.to_string(), "seasonId": "8",
                "gate": null, "faucet": null, "prizeProgram": null, "prizeMint": null,
                "masterSeedSha256": hex::encode(Sha256::digest(seed)),
                "inviteSecretSha256": hex::encode(Sha256::digest(invite))
            },
            "quota": {}, "invitesUsed": {}
        });
        std::fs::write(&state_path, state.to_string()).unwrap();
        assert!(check_relay_state(&state_path, game, 8, &prize, &seed, &invite).is_ok());
        assert!(check_relay_state(&state_path, game, 9, &prize, &seed, &invite).is_err());
        assert!(check_relay_state(&state_path, game, 8, &prize, &[5; 32], &invite).is_err());
        state["quota"] = Value::Null;
        std::fs::write(&state_path, state.to_string()).unwrap();
        assert!(check_relay_state(&state_path, game, 8, &prize, &seed, &invite).is_err());
        std::fs::write(&state_path, b"{").unwrap();
        assert!(check_relay_state(&state_path, game, 8, &prize, &seed, &invite).is_err());

        // Fixed synthetic bytes stay in memory: no test key file is written.
        let fixed = [6u8; 32];
        let pair = Keypair::new_from_array(fixed);
        let bytes = pair.to_bytes();
        assert!(keypair_matches(&bytes, fixed, pair.pubkey()));
        assert!(!keypair_matches(&bytes, fixed, game));
        assert!(!keypair_matches(&bytes, [8; 32], pair.pubkey()));
        let mut wrong = bytes;
        wrong[63] ^= 1;
        assert!(!keypair_matches(&wrong, fixed, pair.pubkey()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn loader_program_preflight_checks_exact_elf_and_zero_padding() {
        let program = Address::new_from_array([7; 32]);
        let pd_address = fclient::addr::programdata(&program);
        let authority = Address::new_from_array([5; 32]);
        let loader = fclient::addr::address(fclient::abi::LOADER_V3);
        let so = [b"\x7fELF\x02\x01".as_slice(), &[4; 58]].concat();
        let mut program_data = vec![0; 36];
        program_data[..4].copy_from_slice(&2u32.to_le_bytes());
        program_data[4..36].copy_from_slice(pd_address.as_ref());
        let program_account = Account {
            lamports: 1,
            data: program_data,
            owner: loader,
            executable: true,
        };
        let mut pd_data = vec![0; 45 + so.len() + 16];
        pd_data[..4].copy_from_slice(&3u32.to_le_bytes());
        pd_data[4..12].copy_from_slice(&42u64.to_le_bytes());
        pd_data[12] = 1;
        pd_data[13..45].copy_from_slice(authority.as_ref());
        pd_data[45..45 + so.len()].copy_from_slice(&so);
        let pd_account = Account {
            lamports: 1,
            data: pd_data,
            owner: loader,
            executable: false,
        };
        let check = |pa: &Account, pd: &Account| {
            check_loader_program(program, pd_address, authority, pa, pd, &so)
        };
        assert!(check(&program_account, &pd_account).is_ok());

        let mut wrong = program_account.clone();
        wrong.data[4] ^= 1;
        assert!(check(&wrong, &pd_account).is_err());
        let mut wrong = program_account.clone();
        wrong.executable = false;
        assert!(check(&wrong, &pd_account).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[0] = 9;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[45] ^= 1;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[45 + so.len()] = 1;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[12] = 2;
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[12] = 0;
        wrong.data[13..45].fill(0);
        assert!(check(&program_account, &wrong).is_err());
        let mut wrong = pd_account.clone();
        wrong.data[13] ^= 1;
        assert!(check(&program_account, &wrong).is_err());
        assert!(check_loader_program(
            program,
            Address::new_from_array([8; 32]),
            authority,
            &program_account,
            &pd_account,
            &so
        )
        .is_err());
    }

    #[test]
    fn prize_preflight_checks_saved_identity_and_real_account_layouts() {
        use prize_pool as p;
        let game = Address::new_from_array([7; 32]);
        let program = Address::new_from_array([8; 32]);
        let authority = Address::new_from_array([9; 32]);
        let faucet = Address::new_from_array([10; 32]);
        let mint_key = Address::new_from_array([11; 32]);
        let season_id = 12u64;
        let season = Addresses::new(game, season_id).season;
        let (pool_key, pool_bump) = Address::find_program_address(
            &[b"pool", game.as_ref(), &season_id.to_le_bytes()],
            &program,
        );
        let (vault_key, vault_bump) =
            Address::find_program_address(&[b"vault", pool_key.as_ref()], &program);
        let mut state = json!({
            "config": {"prize": {"entry_fee": 25, "ops_bps": 2000, "keeps": 6}},
            "prize": {
                "test_assets_only": true, "program": program.to_string(),
                "pool": pool_key.to_string(), "vault": vault_key.to_string(),
                "mint": mint_key.to_string(), "faucet": faucet.to_string(),
                "decimals": 6, "entry_fee": 25, "ops_bps": 2000,
                "expected_keeps": 6, "params_hash": hex::encode([13; 32]),
                "so_sha256": hex::encode([14; 32])
            }
        });
        let saved = saved_prize(&state, game, season_id).unwrap();
        state["prize"]["so_sha256"] = Value::Null;
        assert!(saved_prize(&state, game, season_id).is_err());
        state["prize"]["so_sha256"] = json!(hex::encode([14; 32]));
        let token: Address = crate::prize::TOKEN_PROGRAM.parse().unwrap();
        let mut pool_data = vec![0; p::SIZE];
        pool_data[..8].copy_from_slice(p::MAGIC);
        pool_data[p::BUMP] = pool_bump;
        pool_data[p::VAULT_BUMP] = vault_bump;
        pool_data[p::DECIMALS] = 6;
        pool_data[p::SEASON_ID..p::SEASON_ID + 8].copy_from_slice(&season_id.to_le_bytes());
        pool_data[p::GAME_PROGRAM..p::GAME_PROGRAM + 32].copy_from_slice(game.as_ref());
        pool_data[p::SEASON..p::SEASON + 32].copy_from_slice(season.as_ref());
        pool_data[p::OPERATOR..p::OPERATOR + 32].copy_from_slice(authority.as_ref());
        pool_data[p::MINT..p::MINT + 32].copy_from_slice(mint_key.as_ref());
        pool_data[p::VAULT..p::VAULT + 32].copy_from_slice(vault_key.as_ref());
        pool_data[p::FEE..p::FEE + 8].copy_from_slice(&25u64.to_le_bytes());
        pool_data[p::OPS_BPS..p::OPS_BPS + 2].copy_from_slice(&2000u16.to_le_bytes());
        pool_data[p::EXPECTED_KEEPS..p::EXPECTED_KEEPS + 2].copy_from_slice(&6u16.to_le_bytes());
        pool_data[p::PARAMS_HASH..p::PARAMS_HASH + 32].copy_from_slice(&[13; 32]);
        pool_data[p::END_BELL..p::END_BELL + 4].copy_from_slice(&100u32.to_le_bytes());
        pool_data[p::ENTRIES..p::ENTRIES + 4].copy_from_slice(&2u32.to_le_bytes());
        pool_data[p::COLLECTED..p::COLLECTED + 8].copy_from_slice(&50u64.to_le_bytes());
        pool_data[p::PRIZE..p::PRIZE + 8].copy_from_slice(&40u64.to_le_bytes());
        pool_data[p::OPS..p::OPS + 8].copy_from_slice(&10u64.to_le_bytes());
        let pool = Account {
            lamports: 1,
            data: pool_data,
            owner: program,
            executable: false,
        };
        let mut vault_data = vec![0; 165];
        vault_data[..32].copy_from_slice(mint_key.as_ref());
        vault_data[32..64].copy_from_slice(pool_key.as_ref());
        vault_data[64..72].copy_from_slice(&50u64.to_le_bytes());
        vault_data[108] = 1;
        let vault = Account {
            lamports: 1,
            data: vault_data,
            owner: token,
            executable: false,
        };
        let mut mint_data = vec![0; 82];
        mint_data[..4].copy_from_slice(&1u32.to_le_bytes());
        mint_data[4..36].copy_from_slice(faucet.as_ref());
        mint_data[44] = 6;
        mint_data[45] = 1;
        let mint = Account {
            lamports: 1,
            data: mint_data,
            owner: token,
            executable: false,
        };
        let check = |pool: &Account, vault: &Account, mint: &Account| {
            check_prize_accounts(
                &saved,
                game,
                season_id,
                season,
                authority,
                100,
                [pool, vault, mint],
            )
        };
        assert!(check(&pool, &vault, &mint).is_ok());
        // Claims and operator withdrawals legitimately lower the vault's
        // unpaid amount; a donation may raise its balance above that amount.
        let mut paid_pool = pool.clone();
        paid_pool.data[p::STATE] = 2;
        paid_pool.data[p::MODE] = 1;
        paid_pool.data[p::CLAIMED..p::CLAIMED + 8].copy_from_slice(&10u64.to_le_bytes());
        paid_pool.data[p::OPS_WITHDRAWN..p::OPS_WITHDRAWN + 8].copy_from_slice(&5u64.to_le_bytes());
        let mut paid_vault = vault.clone();
        paid_vault.data[64..72].copy_from_slice(&40u64.to_le_bytes());
        assert!(check(&paid_pool, &paid_vault, &mint).is_ok());
        let mut wrong = pool.clone();
        wrong.owner = game;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[0] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[p::BUMP] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[p::SEASON] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[p::FEE] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[p::OPS_BPS] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[p::PARAMS_HASH] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = pool.clone();
        wrong.data[p::COLLECTED] ^= 1;
        assert!(check(&wrong, &vault, &mint).is_err());
        let mut wrong = vault.clone();
        wrong.data[32] ^= 1;
        assert!(check(&pool, &wrong, &mint).is_err());
        let mut wrong = vault.clone();
        wrong.data[64..72].copy_from_slice(&39u64.to_le_bytes());
        assert!(check(&pool, &wrong, &mint).is_err());
        let mut wrong = mint.clone();
        wrong.data[4] ^= 1;
        assert!(check(&pool, &vault, &wrong).is_err());
        let mut wrong = mint.clone();
        wrong.owner = game;
        assert!(check(&pool, &vault, &wrong).is_err());
        state["config"]["prize"]["entry_fee"] = json!(26);
        assert!(saved_prize(&state, game, season_id).is_err());
        state["config"]["prize"]["entry_fee"] = json!(25);
        state["prize"]["pool"] = json!(game.to_string());
        assert!(saved_prize(&state, game, season_id).is_err());

        // The generic LoaderV3 check is also applied to the saved Prize
        // program. A different deployed ELF must fail before services start.
        let pd_key = fclient::addr::programdata(&program);
        let loader = fclient::addr::address(fclient::abi::LOADER_V3);
        let so = [b"\x7fELF\x02\x01".as_slice(), &[4; 10]].concat();
        let mut program_data = vec![0; 36];
        program_data[..4].copy_from_slice(&2u32.to_le_bytes());
        program_data[4..36].copy_from_slice(pd_key.as_ref());
        let program_account = Account {
            lamports: 1,
            data: program_data,
            owner: loader,
            executable: true,
        };
        let mut pd_data = vec![0; 45 + so.len()];
        pd_data[..4].copy_from_slice(&3u32.to_le_bytes());
        pd_data[12] = 1;
        pd_data[13..45].copy_from_slice(authority.as_ref());
        pd_data[45..].copy_from_slice(&so);
        let mut pd_account = Account {
            lamports: 1,
            data: pd_data,
            owner: loader,
            executable: false,
        };
        assert!(check_loader_program(
            program,
            pd_key,
            authority,
            &program_account,
            &pd_account,
            &so
        )
        .is_ok());
        pd_account.data[45] ^= 1;
        assert!(check_loader_program(
            program,
            pd_key,
            authority,
            &program_account,
            &pd_account,
            &so
        )
        .is_err());
    }

    #[test]
    fn saved_season_preflight_refuses_mode_identity_and_old_state_mismatch() {
        let authority = Address::new_from_array([3; 32]);
        let finite = ChainSeasonStamp {
            season_id: 7,
            authority,
            program_version: 4,
            params_hash: [9; 32],
            genesis_ts: 100,
            join_close_bell: 10,
            end_bell: 20,
            continuous_flag: 0,
        };
        let mut saved = json!({
            "config": {"continuous": false},
            "season": {
                "continuous": false,
                "params_hash": hex::encode(finite.params_hash),
                "program_version": 4,
                "genesis_ts": 100,
                "join_close_bell": 10,
                "end_bell": 20
            },
            "play": {"genesis_ts": 100}
        });
        assert!(check_saved_chain(&saved, finite, 7, authority).is_ok());
        assert!(check_saved_chain(&saved, finite, 8, authority).is_err());
        assert!(check_saved_chain(&saved, finite, 7, Address::new_from_array([4; 32])).is_err());

        saved["season"]["params_hash"] = json!(hex::encode([8; 32]));
        assert!(check_saved_chain(&saved, finite, 7, authority).is_err());
        saved["season"]["params_hash"] = json!(hex::encode(finite.params_hash));
        saved["season"]["end_bell"] = json!(21);
        assert!(check_saved_chain(&saved, finite, 7, authority).is_err());
        saved["season"]["end_bell"] = json!(20);
        saved["season"]
            .as_object_mut()
            .unwrap()
            .remove("params_hash");
        assert!(check_saved_chain(&saved, finite, 7, authority)
            .unwrap_err()
            .contains("missing saved Season params hash"));

        saved["season"]["params_hash"] = json!(hex::encode(finite.params_hash));
        // Old finite run files had neither boolean; verified finite chain
        // parameters make that omission safe to interpret as false.
        saved["config"]
            .as_object_mut()
            .unwrap()
            .remove("continuous");
        saved["season"]
            .as_object_mut()
            .unwrap()
            .remove("continuous");
        assert!(check_saved_chain(&saved, finite, 7, authority).is_ok());
        saved["config"]["continuous"] = json!(true);
        assert!(check_saved_chain(&saved, finite, 7, authority).is_err());
        saved["config"]["continuous"] = json!(false);
        let continuous = ChainSeasonStamp {
            join_close_bell: u32::MAX,
            end_bell: u32::MAX,
            continuous_flag: 1,
            ..finite
        };
        assert!(check_saved_chain(&saved, continuous, 7, authority).is_err());
        saved["config"]["continuous"] = json!(true);
        saved["season"]["continuous"] = json!(true);
        saved["season"]["join_close_bell"] = json!(u32::MAX);
        saved["season"]["end_bell"] = json!(u32::MAX);
        assert!(check_saved_chain(&saved, continuous, 7, authority).is_ok());
        assert!(check_saved_chain(
            &saved,
            ChainSeasonStamp {
                continuous_flag: 0,
                ..continuous
            },
            7,
            authority
        )
        .is_err());
        assert!(check_saved_chain(
            &saved,
            ChainSeasonStamp {
                continuous_flag: 0,
                end_bell: 20,
                join_close_bell: 20,
                ..finite
            },
            7,
            authority
        )
        .is_err());
    }

    #[test]
    fn resume_refuses_nonhuman_and_incomplete_worlds() {
        let rd = RunDir::new(std::path::Path::new("/definitely/no/world"), "test");
        assert!(specs(
            &rd,
            &json!({"config":{"continuous":true,"conquest":true,"bots":0}})
        )
        .unwrap_err()
        .contains("continuous"));
        assert!(specs(&rd, &json!({"config":{"conquest":false,"bots":0}}))
            .unwrap_err()
            .contains("human"));
        assert!(specs(&rd, &json!({"config":{"conquest":true,"bots":0}}))
            .unwrap_err()
            .contains("setup"));
    }
}
