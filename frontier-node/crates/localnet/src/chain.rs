//! The chain: LiteSVM with the mainnet feature set (SBPF v2, the SIMD-0388
//! BLS12-381 syscalls, 64 locks), mainnet rent (5,080 lamports per byte incl.
//! the 128-B overhead), a block builder per slot, a scaled Clock, SIMD-0186
//! loaded-data enforcement, the contention emulator, an ordered transaction
//! feed, and crash safety (a ledger WAL plus snapshots, [`crate::persist`]).
//!
//! **Time (I-54).** A slot is 400 ms of real time at every scale; the Clock
//! advances `0.4 × scale` game seconds per slot. The ticker in
//! [`crate::server`] calls [`Chain::produce_block`] every 400 ms;
//! [`crate::InProcess`] calls it on demand (virtual time). A scale change
//! (`frontier_setScale`) takes effect at the next slot boundary. After a
//! restart the chain resumes at the last recorded slot and game time: wall
//! time while the node was down does not advance the game clock.
//!
//! **Blocks.** Pending transactions are ordered by priority (§10.1, highest
//! first; ties by arrival) and executed in sequence while the block's cost
//! stays ≤ 100M and each writable account's ≤ 40M. The cost is Agave's
//! cost-tracker cost, the §10.1 formula `fees::cost` = the requested CU
//! limit + 720 per signature + 300 per write lock + 8 per 32 KiB of the
//! loaded-data limit (not the CU limit alone: integ-W2 review of W2-C);
//! read-only accounts are not capped. The rest wait for the next slot, and
//! are dropped when their blockhash expires (150 slots). A transaction that
//! cannot execute at block time (fee payer short, account missing) gives
//! its cost back and counts as dropped.
//!
//! **Contention emulator** (`frontier_hold(keys, priority_milli, slots)`).
//! A hold stands for an attacker's filler stream: transactions at priority
//! `p` that write every held key (≤ 64, a transaction's lock limit). In each
//! of its slots the block builder, when it reaches priority `p` in its
//! order, fills every held key's remaining 40M account budget (and the same
//! CU of the block budget, the filler writing all its keys at once). So a
//! transaction that writes a held key lands only when its priority
//! **exceeds** `p` (ties lose: the filler arrived first), exactly as with a
//! real flood; transactions that only read a held key are unaffected
//! (SP-FEE measured write contention only). The notional price of a hold
//! (`Σ filled CU × p`) is reported for the stack's adversary report.
//!
//! **Loaded data (I-45).** Before execution the node computes SIMD-0186's
//! loaded size — Σ(data + 64) over the message's accounts (the instructions
//! sysvar counts 0) plus, for every invoked LoaderV3 program, its ProgramData
//! (data + 64) — and fails a transaction above its requested limit with
//! `MaxLoadedAccountsDataSizeExceeded`, **fee charged**. LiteSVM 0.16 counts
//! the listed accounts but not the ProgramData, and charges nothing when
//! loading fails (`litesvm_alone_undercounts_programdata` shows it), so the
//! check lives here.
//!
//! **Determinism.** Everything that changes state goes through this type
//! and is recorded: blocks (with their clock values and executed
//! transactions in order), airdrops (credited directly, with a
//! deterministic signature, not through LiteSVM's random faucet), deploys
//! and tamper writes. Blockhashes are a hash chain of the slot numbers, not
//! LiteSVM's. So a snapshot plus the ledger rebuild the same state hash.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use litesvm::LiteSVM;
use serde_json::Value;
use solana_account::Account as SolAccount;
use solana_address::Address;
use solana_clock::Clock;
use solana_hash::Hash;
use solana_message::Message;
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction::Transaction;
use tokio::sync::broadcast;

use fclient::ports::{Account, ClockSysvar, SimResult, Status, TxRecord};
use fclient::vtx::{self, LoadedAddresses};
use fclient::{addr, fees, tx};

use crate::persist::{self, Record, Snapshot, TxEntry, Wal, WalHeader};

/// Real duration of a slot.
struct WriterLock(std::fs::File);
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub const SLOT_MS: u64 = 400;
/// Block CU cap and per-writable-account cap (mainnet).
pub const BLOCK_CU: u64 = 100_000_000;
pub const ACCOUNT_CU: u64 = 40_000_000;
/// A blockhash stays valid this many slots.
pub const BLOCKHASH_SLOTS: u64 = 150;
/// Mainnet rent per byte (incl. the 128-B account overhead).
pub const LAMPORTS_PER_BYTE: u64 = 5_080;
/// SIMD-0186 per-account base.
pub const ACCOUNT_BASE: u64 = 64;
/// A transaction locks at most this many accounts (so does a filler).
pub const MAX_LOCKS: usize = 64;
/// Snapshot period: 36 game bells (§8.7).
pub const SNAPSHOT_EVERY_SECS: i64 = 36 * 600;

/// Node configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// Game seconds per real second (1 = real time, 20 = Mode A).
    pub scale: f64,
    /// Clock `unix_timestamp` at slot 0 (a past date, so every round exists).
    pub g0: i64,
    /// First slot.
    pub slot0: u64,
    /// `frontier_setAccount` allowed (tamper fixtures only).
    pub allow_tamper: bool,
    /// Ledger WAL and snapshots live here (none: in memory only).
    pub data_dir: Option<PathBuf>,
    /// Automatic snapshot period in game seconds (with `data_dir`).
    pub snapshot_every_secs: i64,
    /// Automatic snapshots kept (older ones are deleted).
    pub keep_snapshots: usize,
    /// `fsync` every ledger record (a `kill -9` loses nothing without it;
    /// a power loss can).
    pub fsync: bool,
    /// The Rent sysvar's rate (lamports per byte incl. the 128-B overhead,
    /// SIMD-0194 form: exemption threshold 1.0). Default
    /// [`LAMPORTS_PER_BYTE`] (5,080); another rate (6,960, the pre-SIMD-0194
    /// mainnet one) checks off-chain code that must follow the cluster's
    /// rent (keeper-rent-floor). In-memory chains only: the ledger does not
    /// record it, so [`Chain::open`] refuses another rate with `data_dir`.
    pub lamports_per_byte: u64,
}

impl Default for Config {
    fn default() -> Self {
        // 2026-08-01T00:00:00Z.
        Config {
            scale: 1.0,
            g0: 1_785_542_400,
            slot0: 1,
            allow_tamper: false,
            data_dir: None,
            snapshot_every_secs: SNAPSHOT_EVERY_SECS,
            keep_snapshots: 3,
            fsync: true,
            lamports_per_byte: LAMPORTS_PER_BYTE,
        }
    }
}

/// Why a transaction was refused before it could land (not charged).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendError {
    Decode(String),
    BlockhashNotFound,
    AlreadyProcessed,
    /// Signature verification failed or the message does not sanitize.
    Invalid(String),
    /// The fee payer cannot pay the fee.
    InsufficientFundsForFee,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

struct Pending {
    tx: Txn,
    wire: Vec<u8>,
    arrival: u64,
    priority_milli: u64,
    /// The §10.1 cost the block and account caps count.
    cost: u64,
    blockhash_slot: u64,
    writable: Vec<Address>,
}

/// A transaction of any version (legacy, v0, v1; herald-v0v1-decode) with
/// a v0 transaction's lookups resolved against the chain's state when it
/// was read.
#[derive(Clone, Debug)]
pub struct Txn {
    pub d: vtx::Decoded,
    pub loaded: LoadedAddresses,
    /// Every account in the runtime's order.
    pub keys: Vec<Address>,
    /// A legacy-shaped view (the keys above, the message's header,
    /// blockhash and instructions) for the budget, priority, fee and
    /// loaded-size rules, which read instructions and program ids only
    /// (program ids are static keys in every version). Writability comes
    /// from [`Txn::writable`], never from this view's header. A v1
    /// message's compute budget is in its config mask, not in
    /// instructions: the view reads as having none (LiteSVM applies the
    /// mask itself when it executes).
    pub view: Message,
}

impl Txn {
    pub fn signature(&self) -> Signature {
        self.d.signature()
    }
    pub fn writable(&self) -> Vec<Address> {
        (0..self.keys.len())
            .filter(|&i| self.d.is_writable_index(i, &self.loaded))
            .map(|i| self.keys[i])
            .collect()
    }
    pub fn versioned(&self) -> VersionedTransaction {
        self.d.tx.clone()
    }

    /// The compute budget: a legacy / v0 message's ComputeBudget
    /// instructions; a v1 message's config mask (SIMD-0385 as agave's
    /// runtime-transaction reads it: an absent limit is 0).
    pub fn budget(&self) -> tx::ParsedBudget {
        match &self.d.tx.message {
            solana_message::VersionedMessage::V1(m) => tx::ParsedBudget {
                cu_limit: Some(m.config.compute_unit_limit.unwrap_or(0)),
                cu_price: None,
                loaded_limit: Some(m.config.loaded_accounts_data_size_limit.unwrap_or(0)),
                heap: m.config.heap_size,
                other_ixs: m.instructions.len(),
            },
            _ => tx::parse_budget(&self.view),
        }
    }

    /// The priority fee in lamports (v1: stated as such in its config).
    pub fn priority_fee(&self) -> u64 {
        match &self.d.tx.message {
            solana_message::VersionedMessage::V1(m) => m.config.priority_fee.unwrap_or(0),
            _ => {
                let b = self.budget();
                fees::priority_fee(b.cu_price.unwrap_or(0), b.effective_cu_limit())
            }
        }
    }

    /// The fee the runtime charges (as `tx::fee_lamports`).
    pub fn fee(&self) -> u64 {
        self.d.header.num_required_signatures as u64 * fees::LAMPORTS_PER_SIGNATURE
            + self.priority_fee()
    }

    /// Priority in milli-units and cost (as `tx::priority`, with the
    /// writable count of every version).
    pub fn priority(&self) -> (u64, u64) {
        let b = self.budget();
        let c = fees::cost(
            b.effective_cu_limit(),
            self.d.header.num_required_signatures,
            self.writable().len() as u8,
            b.effective_loaded_limit(),
        );
        (fees::priority_milli(self.priority_fee(), c), c)
    }
}

/// The address lookup table program (a builtin of every cluster).
pub fn lookup_table_program() -> Address {
    "AddressLookupTab1e1111111111111111111111111"
        .parse()
        .expect("address")
}

/// The addresses at `indexes` of a lookup table account's bytes (the
/// 56-byte `LookupTableMeta`, then 32-byte addresses).
pub fn lookup_table_addresses(a: &SolAccount, indexes: &[u8]) -> Result<Vec<Address>, String> {
    if a.owner != lookup_table_program()
        || a.data.len() < 56
        || !(a.data.len() - 56).is_multiple_of(32)
        || a.data[..4] != 1u32.to_le_bytes()
    {
        return Err("not an address lookup table".into());
    }
    let n = (a.data.len() - 56) / 32;
    indexes
        .iter()
        .map(|&i| {
            let i = i as usize;
            if i >= n {
                return Err(format!("lookup index {i} past the table's {n} addresses"));
            }
            Ok(Address::new_from_array(
                a.data[56 + 32 * i..88 + 32 * i].try_into().expect("32"),
            ))
        })
        .collect()
}

/// `CreateLookupTable { recent_slot, bump_seed }` (the program's bincode
/// instruction 0) for `authority`, paid by `payer`; returns the table's
/// address too. `recent_slot` must be in the SlotHashes sysvar.
pub fn lookup_table_create(
    authority: &Address,
    payer: &Address,
    recent_slot: u64,
) -> (Address, solana_instruction::Instruction) {
    use solana_instruction::AccountMeta;
    let (table, bump) = Address::find_program_address(
        &[authority.as_ref(), &recent_slot.to_le_bytes()],
        &lookup_table_program(),
    );
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend(recent_slot.to_le_bytes());
    data.push(bump);
    (
        table,
        solana_instruction::Instruction {
            program_id: lookup_table_program(),
            accounts: vec![
                AccountMeta::new(table, false),
                AccountMeta::new_readonly(*authority, false),
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(addr::system_program(), false),
            ],
            data,
        },
    )
}

/// `ExtendLookupTable { new_addresses }` (the program's bincode instruction 2).
pub fn lookup_table_extend(
    table: &Address,
    authority: &Address,
    payer: &Address,
    new: &[Address],
) -> solana_instruction::Instruction {
    use solana_instruction::AccountMeta;
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend((new.len() as u64).to_le_bytes());
    for a in new {
        data.extend(a.to_bytes());
    }
    solana_instruction::Instruction {
        program_id: lookup_table_program(),
        accounts: vec![
            AccountMeta::new(*table, false),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(addr::system_program(), false),
        ],
        data,
    }
}

/// A landed or failed-and-charged transaction, or an airdrop (`airdrop`:
/// a synthetic faucet transfer, credited directly, never in the feed).
#[derive(Clone, Debug)]
pub struct Landed {
    pub airdrop: bool,
    pub seq: u64,
    pub slot: u64,
    pub block_time: i64,
    pub signature: Signature,
    pub wire: Vec<u8>,
    /// Every account in the runtime's order (static keys, then a v0
    /// transaction's looked-up writable and readonly addresses).
    pub keys: Vec<Address>,
    /// herald-v0v1-decode: a v0 transaction's lookup addresses (empty for
    /// legacy and v1), as `getTransaction` serves `meta.loadedAddresses`.
    pub loaded: LoadedAddresses,
    pub logs: Vec<String>,
    /// Debug form of the error (`fclient` parses custom codes out of it).
    pub err: Option<String>,
    /// The error as JSON-RPC serves it (`{"InstructionError":[3,{"Custom":12}]}`).
    pub err_json: Value,
    pub code: Option<u32>,
    pub units: u64,
    pub fee: u64,
    pub post: Vec<(Address, Option<Account>)>,
    pub return_data: Vec<u8>,
    pub pre_balances: Vec<u64>,
    pub post_balances: Vec<u64>,
}

impl Landed {
    pub fn record(&self) -> TxRecord {
        TxRecord {
            seq: self.seq,
            slot: self.slot,
            signature: self.signature,
            block_time: self.block_time,
            tx: self.wire.clone(),
            logs: self.logs.clone(),
            err: self.err.clone(),
            code: self.code,
            units: self.units,
            fee: self.fee,
            post: self.post.clone(),
            loaded: self.loaded.clone(),
        }
    }

    fn entry(&self) -> TxEntry {
        TxEntry {
            signature: self.signature,
            wire: self.wire.clone(),
            logs: self.logs.clone(),
            err: self.err.clone(),
            err_json: (!self.err_json.is_null()).then(|| self.err_json.to_string()),
            code: self.code,
            units: self.units,
            fee: self.fee,
            post: self.post.clone(),
            return_data: self.return_data.clone(),
            pre_balances: self.pre_balances.clone(),
            post_balances: self.post_balances.clone(),
            loaded: self.loaded.clone(),
        }
    }

    fn from_entry(e: TxEntry, seq: u64, slot: u64, block_time: i64) -> Landed {
        let keys = vtx::decode(&e.wire)
            .and_then(|t| t.keys(&e.loaded))
            .unwrap_or_default();
        Landed {
            airdrop: false,
            seq,
            slot,
            block_time,
            signature: e.signature,
            wire: e.wire,
            keys,
            loaded: e.loaded,
            logs: e.logs,
            err: e.err,
            err_json: e
                .err_json
                .and_then(|s: String| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null),
            code: e.code,
            units: e.units,
            fee: e.fee,
            post: e.post,
            return_data: e.return_data,
            pre_balances: e.pre_balances,
            post_balances: e.post_balances,
        }
    }
}

/// What one block did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlockReport {
    pub slot: u64,
    pub unix_timestamp: i64,
    pub landed: usize,
    pub failed: usize,
    pub deferred: usize,
    pub dropped: usize,
    /// §10.1 cost of the executed transactions plus the holds' filler.
    pub cu: u64,
    /// Of `cu`, the part the holds' filler took.
    pub hold_cu: u64,
}

/// An active contention hold (`frontier_hold`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub id: u64,
    pub keys: Vec<Address>,
    /// Priority of the filler, milli-lamports per cost unit (§10.1).
    pub priority_milli: u64,
    /// First and last slot the hold fills (inclusive).
    pub from_slot: u64,
    pub until_slot: u64,
    /// CU the filler took so far, and its notional price in lamports
    /// (`Σ filled × priority`).
    pub filled_cu: u64,
    pub notional_lamports: u64,
}

/// A chain event for the WebSocket subscriptions.
#[derive(Clone, Debug)]
pub enum Event {
    Slot(u64),
    Tx {
        slot: u64,
        signature: Signature,
        err: Value,
        logs: Vec<String>,
        keys: Vec<Address>,
    },
}

/// A written snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapInfo {
    pub slot: u64,
    pub path: PathBuf,
    pub state_hash: [u8; 32],
    pub accounts: usize,
    pub bytes: u64,
}

pub struct Chain {
    pub svm: LiteSVM,
    cfg: Config,
    run_id: [u8; 16],
    /// Runtime-only identity of this running chain instance, fresh from OS
    /// entropy at every open and every restore. Never persisted or hashed
    /// (not in Snapshot, WAL, state_hash, genesis or blockhashes); served in
    /// the `getSignatureStatuses` context so a client can tell a "null" of
    /// the same instance from one after a restart or rewind.
    status_instance: [u8; 32],
    slot: u64,
    /// Game time in milliseconds (the Clock shows its floor in seconds).
    game_ms: i64,
    scale: f64,
    pending_scale: Option<f64>,
    paused: bool,
    blockhashes: VecDeque<(Hash, u64)>,
    mempool: Vec<Pending>,
    arrivals: u64,
    landed: Vec<Landed>,
    by_sig: HashMap<Signature, usize>,
    block_times: BTreeMap<u64, i64>,
    /// Each slot a transaction landed in: its blockhash, its parent slot and
    /// the parent's blockhash (`getBlock`, a verifier's second source:
    /// verifier-witness). Memory only, like `block_times`; a ledger replay
    /// rebuilds it, history loaded from a snapshot has none.
    blocks: BTreeMap<u64, (Hash, u64, Hash)>,
    /// Signatures refused at execution without a charge (e.g. an
    /// `InsufficientFundsForFee` at block time) or expired; reported absent.
    dropped: HashSet<Signature>,
    holds: Vec<Hold>,
    next_hold: u64,
    wal: Option<Wal>,
    // Acquired before reading or replaying the WAL; released on process exit.
    writer_lock: Option<WriterLock>,
    next_snapshot_ms: i64,
    events: broadcast::Sender<Arc<Event>>,
}

fn to_account(a: SolAccount) -> Account {
    Account {
        lamports: a.lamports,
        data: a.data,
        owner: a.owner,
        executable: a.executable,
    }
}

fn to_sol(a: Account) -> SolAccount {
    SolAccount {
        lamports: a.lamports,
        data: a.data,
        owner: a.owner,
        executable: a.executable,
        rent_epoch: u64::MAX,
    }
}

fn new_run_id() -> [u8; 16] {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let h = persist::sha256(&[
        b"PSF-LOCALNET-RUN".as_slice(),
        &t.to_le_bytes(),
        &std::process::id().to_le_bytes(),
    ]);
    h[..16].try_into().expect("16")
}

/// 32 bytes of OS entropy for [`Chain::status_instance`]. Fail-closed: any
/// I/O error, and an all-zero result, is an error. No time/PID fallback.
fn os_entropy32() -> Result<[u8; 32], String> {
    use std::io::Read;
    let mut b = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .map_err(|e| format!("runner instance entropy unavailable: {e}"))?;
    checked_instance(b)
}

fn checked_instance(b: [u8; 32]) -> Result<[u8; 32], String> {
    if b == [0u8; 32] {
        return Err("runner instance entropy is all zero".into());
    }
    Ok(b)
}

fn genesis_blockhash(g0: i64, slot0: u64) -> Hash {
    Hash::new_from_array(persist::sha256(&[
        b"PSF-LOCALNET-GENESIS".as_slice(),
        &g0.to_le_bytes(),
        &slot0.to_le_bytes(),
    ]))
}

/// The chain's first blockhash (`getGenesisHash`).
pub fn genesis_hash(cfg: &Config) -> Hash {
    genesis_blockhash(cfg.g0, cfg.slot0)
}

fn next_blockhash(prev: &Hash, slot: u64) -> Hash {
    Hash::new_from_array(persist::sha256(&[
        b"PSF-LOCALNET-BLOCKHASH".as_slice(),
        prev.as_ref(),
        &slot.to_le_bytes(),
    ]))
}

/// The faucet key of synthetic airdrop transactions (a fixed key: the
/// faucet holds nothing; airdrops mint).
pub fn faucet() -> fclient::Keypair {
    fclient::Keypair::new_from_array(persist::sha256(&[b"PSF-LOCALNET-FAUCET".as_slice()]))
}

/// The synthetic, deterministic transaction of airdrop `seq`: a system
/// transfer from [`faucet`] signed over a blockhash unique to `seq`.
fn airdrop_tx(seq: u64, latest: &Hash, k: &Address, lamports: u64) -> Transaction {
    let f = faucet();
    use fclient::Signer;
    let bh = Hash::new_from_array(persist::sha256(&[
        b"PSF-LOCALNET-AIRDROP".as_slice(),
        latest.as_ref(),
        &seq.to_le_bytes(),
    ]));
    let msg = Message::new_with_blockhash(
        &[tx::transfer(f.pubkey(), *k, lamports)],
        Some(&f.pubkey()),
        &bh,
    );
    tx::sign(msg, &[&f]).expect("the faucet signs")
}

/// The JSON-RPC form of a `TransactionError` (its serde form).
macro_rules! err_value {
    ($e:expr) => {
        serde_json::to_value($e).unwrap_or(Value::Null)
    };
}

impl Chain {
    /// An in-memory chain, or with `cfg.data_dir` the recovered one (see
    /// [`Chain::open`]). Panics only if recovery fails.
    pub fn new(cfg: Config) -> Chain {
        Chain::open(cfg).unwrap_or_else(|e| panic!("frontier-localnet: {e}"))
    }

    fn fresh(cfg: Config, run_id: [u8; 16], status_instance: [u8; 32]) -> Chain {
        let mut svm = LiteSVM::new()
            .with_blockhash_check(false)
            .with_log_bytes_limit(Some(200_000))
            .with_transaction_history(0);
        let mut rent: solana_rent::Rent = svm.get_sysvar();
        rent.lamports_per_byte = cfg.lamports_per_byte;
        #[allow(deprecated)]
        {
            rent.exemption_threshold = 1.0f64.to_le_bytes();
        }
        svm.set_sysvar(&rent);
        // LiteSVM's faucet is a random key: remove it, airdrops mint.
        let faucet = svm.airdrop_pubkey();
        let _ = svm.set_account(
            faucet,
            SolAccount {
                lamports: 0,
                ..Default::default()
            },
        );
        let (tx, _) = broadcast::channel(8_192);
        let mut c = Chain {
            svm,
            run_id,
            status_instance,
            slot: cfg.slot0,
            game_ms: cfg.g0 * 1_000,
            scale: cfg.scale,
            next_snapshot_ms: cfg.g0 * 1_000 + cfg.snapshot_every_secs.max(1) * 1_000,
            cfg,
            pending_scale: None,
            paused: false,
            blockhashes: VecDeque::new(),
            mempool: vec![],
            arrivals: 0,
            landed: vec![],
            by_sig: HashMap::new(),
            block_times: BTreeMap::new(),
            blocks: BTreeMap::new(),
            dropped: HashSet::new(),
            holds: vec![],
            next_hold: 1,
            wal: None,
            writer_lock: None,
            events: tx,
        };
        c.write_clock();
        c.blockhashes
            .push_back((genesis_blockhash(c.cfg.g0, c.slot), c.slot));
        c.block_times.insert(c.slot, c.unix_timestamp());
        c
    }

    /// Opens the chain. Without `data_dir`: a fresh in-memory chain. With
    /// it: a fresh chain and a new ledger if the directory has none;
    /// otherwise the recovered chain (newest valid snapshot + the ledger
    /// re-executed after it; the header's g0, slot0 and scale win over
    /// `cfg`'s).
    pub fn open(cfg: Config) -> Result<Chain, String> {
        Chain::open_with(cfg, os_entropy32)
    }

    /// [`Chain::open`] with an injected entropy source (tests). The instance
    /// is taken first, so an entropy failure opens nothing.
    fn open_with(
        mut cfg: Config,
        entropy: impl FnOnce() -> Result<[u8; 32], String>,
    ) -> Result<Chain, String> {
        let instance = checked_instance(entropy()?)?;
        if cfg.data_dir.is_some() && cfg.lamports_per_byte != LAMPORTS_PER_BYTE {
            return Err(format!(
                "a rent rate other than {LAMPORTS_PER_BYTE} lamports/byte is for in-memory chains only"
            ));
        }
        if cfg.lamports_per_byte == 0 {
            return Err("the rent rate must be at least 1 lamport/byte".into());
        }
        let Some(dir) = cfg.data_dir.clone() else {
            return Ok(Chain::fresh(cfg, new_run_id(), instance));
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let writer_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("writer.lock"))
            .map_err(|e| e.to_string())?;
        writer_lock
            .try_lock()
            .map_err(|e| format!("ledger already has a writer: {e}"))?;
        let wal_path = dir.join(persist::WAL_FILE);
        if !wal_path.exists() {
            let run_id = new_run_id();
            let header = WalHeader {
                run_id,
                g0: cfg.g0,
                slot0: cfg.slot0,
                scale: cfg.scale,
            };
            let wal = Wal::create(&dir, header, cfg.fsync)?;
            let mut c = Chain::fresh(cfg, run_id, instance);
            c.writer_lock = Some(WriterLock(writer_lock));
            c.wal = Some(wal);
            return Ok(c);
        }
        let (h, recs, valid) = persist::read_wal(&wal_path)?;
        cfg.g0 = h.g0;
        cfg.slot0 = h.slot0;
        cfg.scale = h.scale;
        let fsync = cfg.fsync;
        let mut c = Chain::fresh(cfg, h.run_id, instance);
        c.writer_lock = Some(WriterLock(writer_lock));
        let snap = persist::snapshots_in(&dir).into_iter().find_map(|(_, p)| {
            Snapshot::read(&p)
                .ok()
                .filter(|s| s.run_id == h.run_id && s.wal_offset <= valid)
        });
        let skip_to = match &snap {
            Some(s) => {
                c.apply_snapshot(s)?;
                s.wal_offset
            }
            None => persist::WAL_HEADER,
        };
        let mut replayed = 0usize;
        for (end, rec) in recs {
            if end <= skip_to {
                c.load_history(rec);
            } else {
                if replayed == 0 {
                    if let Some(s) = &snap {
                        if c.landed.len() as u64 != s.landed_len {
                            return Err(format!(
                                "snapshot at slot {} expects {} history entries, the ledger has {}",
                                s.slot,
                                s.landed_len,
                                c.landed.len()
                            ));
                        }
                    }
                }
                c.replay(rec)?;
                replayed += 1;
            }
        }
        if replayed == 0 {
            if let Some(s) = &snap {
                if c.landed.len() as u64 != s.landed_len {
                    return Err(format!(
                        "snapshot at slot {} expects {} history entries, the ledger has {}",
                        s.slot,
                        s.landed_len,
                        c.landed.len()
                    ));
                }
            }
        }
        c.wal = Some(Wal::reopen(&wal_path, h, valid, fsync)?);
        Ok(c)
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }
    pub fn run_id(&self) -> [u8; 16] {
        self.run_id
    }
    /// This running instance's runtime-only identity (see the field).
    pub fn status_instance(&self) -> [u8; 32] {
        self.status_instance
    }
    pub fn slot(&self) -> u64 {
        self.slot
    }
    pub fn unix_timestamp(&self) -> i64 {
        self.game_ms.div_euclid(1_000)
    }
    pub fn game_ms(&self) -> i64 {
        self.game_ms
    }
    pub fn scale(&self) -> f64 {
        self.scale
    }
    pub fn paused(&self) -> bool {
        self.paused
    }
    pub fn set_paused(&mut self, p: bool) {
        self.paused = p;
    }
    /// Takes effect at the next slot boundary (`frontier_setScale`).
    pub fn set_scale(&mut self, s: f64) {
        self.pending_scale = Some(s);
    }
    pub fn pending_scale(&self) -> Option<f64> {
        self.pending_scale
    }
    pub fn clock(&self) -> ClockSysvar {
        ClockSysvar {
            slot: self.slot,
            epoch_start_timestamp: self.cfg.g0,
            epoch: 0,
            leader_schedule_epoch: 1,
            unix_timestamp: self.unix_timestamp(),
        }
    }
    pub fn block_time(&self, slot: u64) -> Option<i64> {
        self.block_times.get(&slot).copied()
    }
    /// A receiver of slot and transaction events (WebSocket subscriptions).
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.events.subscribe()
    }
    /// Bytes of the ledger so far (0 without a data dir).
    pub fn wal_offset(&self) -> u64 {
        self.wal.as_ref().map(|w| w.offset).unwrap_or(0)
    }

    fn write_clock(&mut self) {
        let c = self.clock();
        self.svm.set_sysvar(&Clock {
            slot: c.slot,
            epoch_start_timestamp: c.epoch_start_timestamp,
            epoch: c.epoch,
            leader_schedule_epoch: c.leader_schedule_epoch,
            unix_timestamp: c.unix_timestamp,
        });
    }

    pub fn latest_blockhash(&self) -> (Hash, u64) {
        let (h, s) = *self.blockhashes.back().expect("a blockhash");
        (h, s + BLOCKHASH_SLOTS)
    }

    fn blockhash_slot(&self, h: &Hash) -> Option<u64> {
        self.blockhashes
            .iter()
            .find(|(x, _)| x == h)
            .map(|(_, s)| *s)
    }

    /// Whether `h` is still a valid recent blockhash (`isBlockhashValid`).
    pub fn blockhash_valid(&self, h: &Hash) -> bool {
        self.blockhash_slot(h)
            .is_some_and(|s| s + BLOCKHASH_SLOTS >= self.slot)
    }

    fn advance_blockhash(&mut self) {
        let (prev, _) = *self.blockhashes.back().expect("a blockhash");
        self.blockhashes
            .push_back((next_blockhash(&prev, self.slot), self.slot));
        while self
            .blockhashes
            .front()
            .is_some_and(|(_, s)| s + BLOCKHASH_SLOTS < self.slot)
        {
            self.blockhashes.pop_front();
        }
        // herald-v0v1-decode: the SlotHashes sysvar follows the slots whose
        // blockhash is still valid (newest first), as a cluster's does for
        // its recent slots: the lookup-table program's CreateLookupTable
        // takes a `recent_slot` it must find there (before, LiteSVM's
        // genesis entry for slot 0 was the only one). Deterministic from the
        // blockhash chain, so a replay and a restored snapshot (which keeps
        // both the accounts and the blockhashes) agree.
        let entries: Vec<(u64, Hash)> = self
            .blockhashes
            .iter()
            .rev()
            .map(|(h, s)| (*s, Hash::new_from_array(h.to_bytes())))
            .collect();
        self.svm
            .set_sysvar(&solana_slot_hashes::SlotHashes::new(&entries));
    }

    fn log(&mut self, rec: &Record) -> Result<(), String> {
        match self.wal.as_mut() {
            Some(w) => w.append(rec),
            None => Ok(()),
        }
    }

    /// Records a change already applied (under the node's lock, so nothing
    /// saw it yet). A ledger that cannot be written stops the node:
    /// continuing would serve state a restart forgets.
    fn record(&mut self, rec: &Record) {
        if let Err(e) = self.log(rec) {
            eprintln!(
                "frontier-localnet: ledger write failed at slot {}: {e}",
                self.slot
            );
            std::process::abort();
        }
    }

    // ------------------------------------------------------------ programs and accounts

    /// Deploys `so` under LoaderV3 at `program` with ProgramData of `max_len`
    /// bytes (≥ the ELF; zero padded as a real `--max-len` deploy) and the
    /// given upgrade authority (AnnounceSeason reads it, I-51).
    pub fn deploy(
        &mut self,
        program: Address,
        so: &[u8],
        max_len: usize,
        authority: Option<Address>,
    ) -> Result<(), String> {
        let max_len = max_len.max(so.len());
        // Applied first: a deploy LiteSVM refuses is never recorded.
        self.deploy_inner(program, so, max_len, authority)?;
        self.record(&Record::Deploy {
            program,
            max_len: max_len as u64,
            authority,
            so: so.to_vec(),
        });
        Ok(())
    }

    fn deploy_inner(
        &mut self,
        program: Address,
        so: &[u8],
        max_len: usize,
        authority: Option<Address>,
    ) -> Result<(), String> {
        let loader = addr::address(fclient::abi::LOADER_V3);
        let pd = addr::programdata(&program);
        let mut data = vec![0u8; fees::PROGRAMDATA_META as usize + max_len];
        data[..4].copy_from_slice(&3u32.to_le_bytes()); // UpgradeableLoaderState::ProgramData
        data[4..12].copy_from_slice(&self.slot.to_le_bytes());
        if let Some(a) = authority {
            data[12] = 1;
            data[13..45].copy_from_slice(a.as_ref());
        }
        data[45..45 + so.len()].copy_from_slice(so);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                pd,
                SolAccount {
                    lamports,
                    data,
                    owner: loader,
                    executable: false,
                    rent_epoch: u64::MAX,
                },
            )
            .map_err(|e| format!("programdata: {e:?}"))?;
        let mut pdata = vec![0u8; 36];
        pdata[..4].copy_from_slice(&2u32.to_le_bytes()); // UpgradeableLoaderState::Program
        pdata[4..].copy_from_slice(pd.as_ref());
        let lamports = self.svm.minimum_balance_for_rent_exemption(36);
        self.svm
            .set_account(
                program,
                SolAccount {
                    lamports,
                    data: pdata,
                    owner: loader,
                    executable: true,
                    rent_epoch: u64::MAX,
                },
            )
            .map_err(|e| format!("program: {e:?}"))
    }

    pub fn account(&self, k: &Address) -> Option<Account> {
        self.svm
            .get_account(k)
            .filter(|a| a.lamports > 0 || !a.data.is_empty())
            .map(to_account)
    }

    pub fn balance(&self, k: &Address) -> u64 {
        self.svm.get_balance(k).unwrap_or(0)
    }

    /// Writes an account directly (tamper fixtures; recorded in the ledger).
    pub fn set_account(&mut self, k: Address, a: Account) -> Result<(), String> {
        self.set_inner(k, Some(a.clone()))?;
        self.record(&Record::SetAccount {
            key: k,
            account: Some(a),
        });
        Ok(())
    }

    fn set_inner(&mut self, k: Address, a: Option<Account>) -> Result<(), String> {
        let a = a.map(to_sol).unwrap_or_default();
        self.svm.set_account(k, a).map_err(|e| format!("{e:?}"))
    }

    pub fn program_accounts(&self, program: &Address) -> Vec<(Address, Account)> {
        self.svm
            .get_program_accounts(program)
            .into_iter()
            .map(|(k, a)| (k, to_account(a)))
            .collect()
    }

    fn credit(&mut self, k: &Address, lamports: u64) -> Result<(), String> {
        let mut a = self.svm.get_account(k).unwrap_or(SolAccount {
            lamports: 0,
            data: vec![],
            owner: addr::system_program(),
            executable: false,
            rent_epoch: u64::MAX,
        });
        a.lamports = a
            .lamports
            .checked_add(lamports)
            .ok_or("airdrop overflows the balance")?;
        self.svm.set_account(*k, a).map_err(|e| format!("{e:?}"))
    }

    /// Credits `lamports` at once (not through a block), recorded in the
    /// status table and the ledger at the current slot with a
    /// deterministic signature.
    pub fn airdrop(&mut self, k: &Address, lamports: u64) -> Result<Signature, String> {
        if self.balance(k).checked_add(lamports).is_none() {
            return Err("airdrop overflows the balance".into());
        }
        let seq = self.landed.len() as u64 + 1;
        let (latest, _) = *self.blockhashes.back().expect("a blockhash");
        let t = airdrop_tx(seq, &latest, k, lamports);
        let sig = tx::signature(&t);
        let wire = tx::wire(&t);
        let slot = self.slot;
        self.apply_airdrop(k, lamports, sig, wire.clone())?;
        self.record(&Record::Airdrop {
            slot,
            key: *k,
            lamports,
            signature: sig,
            wire,
        });
        Ok(sig)
    }

    fn airdrop_landed(
        &self,
        seq: u64,
        slot: u64,
        sig: Signature,
        wire: Vec<u8>,
        pre: u64,
        post: u64,
    ) -> Landed {
        let keys = tx::from_wire(&wire)
            .map(|t| t.message.account_keys)
            .unwrap_or_default();
        Landed {
            airdrop: true,
            seq,
            slot,
            block_time: self.block_times.get(&slot).copied().unwrap_or(0),
            signature: sig,
            wire,
            keys,
            loaded: LoadedAddresses::default(),
            logs: vec![
                "Program 11111111111111111111111111111111 invoke [1]".into(),
                "Program 11111111111111111111111111111111 success".into(),
            ],
            err: None,
            err_json: Value::Null,
            code: None,
            units: 150,
            fee: 0,
            post: vec![],
            return_data: vec![],
            pre_balances: vec![0, pre, 1],
            post_balances: vec![0, post, 1],
        }
    }

    fn apply_airdrop(
        &mut self,
        k: &Address,
        lamports: u64,
        sig: Signature,
        wire: Vec<u8>,
    ) -> Result<(), String> {
        let pre = self.balance(k);
        self.credit(k, lamports)?;
        let seq = self.landed.len() as u64 + 1;
        let l = self.airdrop_landed(seq, self.slot, sig, wire, pre, self.balance(k));
        self.push_landed(l);
        Ok(())
    }

    fn push_landed(&mut self, l: Landed) {
        // Its block's identity, while the slot's blockhash is the newest
        // (not for history loaded from a snapshot: its hashes are not kept).
        if let (false, Some(&(h, s))) = (self.blocks.contains_key(&l.slot), self.blockhashes.back())
        {
            if s == l.slot {
                let n = self.blockhashes.len();
                let (ph, ps) = if n >= 2 {
                    self.blockhashes[n - 2]
                } else {
                    (h, s)
                };
                self.blocks.insert(l.slot, (h, ps, ph));
            }
        }
        self.by_sig.insert(l.signature, self.landed.len());
        self.landed.push(l);
    }

    // ------------------------------------------------------------ loaded data (I-45)

    /// SIMD-0186 loaded size of `msg` against the current state.
    pub fn loaded_size(&self, msg: &Message) -> u64 {
        let ix_sysvar = addr::instructions_sysvar();
        let loader = addr::address(fclient::abi::LOADER_V3);
        let keys: HashSet<Address> = msg.account_keys.iter().copied().collect();
        let mut total = 0u64;
        for k in &msg.account_keys {
            if *k == ix_sysvar {
                continue;
            }
            if let Some(a) = self.svm.get_account(k) {
                total += ACCOUNT_BASE + a.data.len() as u64;
            }
        }
        let mut counted: HashSet<Address> = HashSet::new();
        for ci in &msg.instructions {
            let pid = msg.account_keys[ci.program_id_index as usize];
            let Some(p) = self.svm.get_account(&pid) else {
                continue;
            };
            if p.owner != loader || p.data.len() < 36 || p.data[..4] != 2u32.to_le_bytes() {
                continue;
            }
            let pd = Address::new_from_array(p.data[4..36].try_into().expect("32"));
            if keys.contains(&pd) || !counted.insert(pd) {
                continue;
            }
            if let Some(a) = self.svm.get_account(&pd) {
                total += ACCOUNT_BASE + a.data.len() as u64;
            }
        }
        total
    }

    // ------------------------------------------------------------ transactions

    /// The addresses a v0 transaction's lookups name, read from the
    /// tables' current bytes (none for legacy and v1).
    pub fn resolve_lookups(&self, d: &vtx::Decoded) -> Result<LoadedAddresses, SendError> {
        let mut l = LoadedAddresses::default();
        for lk in &d.lookups {
            let a = self.svm.get_account(&lk.account_key).ok_or_else(|| {
                SendError::Invalid(format!("address lookup table {} not found", lk.account_key))
            })?;
            let bad = |e: String| SendError::Invalid(format!("{}: {e}", lk.account_key));
            l.writable
                .extend(lookup_table_addresses(&a, &lk.writable_indexes).map_err(bad)?);
            l.readonly
                .extend(lookup_table_addresses(&a, &lk.readonly_indexes).map_err(bad)?);
        }
        Ok(l)
    }

    /// Decodes a legacy, v0 or v1 wire and resolves its lookups now.
    pub fn txn(&self, wire: &[u8]) -> Result<Txn, SendError> {
        let d = vtx::decode(wire).map_err(SendError::Decode)?;
        let loaded = self.resolve_lookups(&d)?;
        let keys = d.keys(&loaded).map_err(SendError::Invalid)?;
        let view = Message {
            header: d.header,
            account_keys: keys.clone(),
            recent_blockhash: Hash::new_from_array(d.blockhash.to_bytes()),
            instructions: d.instructions.clone(),
        };
        Ok(Txn {
            d,
            loaded,
            keys,
            view,
        })
    }

    fn verify(t: &Txn) -> Result<(), SendError> {
        t.d.tx
            .verify_and_hash_message()
            .map(drop)
            .map_err(|e| SendError::Invalid(e.to_string()))
    }

    /// Accepts a transaction into the mempool (sendTransaction).
    pub fn submit(&mut self, wire: &[u8]) -> Result<Signature, SendError> {
        let t = self.txn(wire)?;
        let sig = t.signature();
        if self.by_sig.contains_key(&sig) || self.mempool.iter().any(|p| p.tx.signature() == sig) {
            return Err(SendError::AlreadyProcessed);
        }
        let bslot = self
            .blockhash_slot(&t.d.blockhash)
            .filter(|s| s + BLOCKHASH_SLOTS >= self.slot)
            .ok_or(SendError::BlockhashNotFound)?;
        Self::verify(&t)?;
        let (priority_milli, cost) = t.priority();
        let writable = t.writable();
        self.arrivals += 1;
        self.dropped.remove(&sig);
        self.mempool.push(Pending {
            tx: t,
            wire: wire.to_vec(),
            arrival: self.arrivals,
            priority_milli,
            cost,
            blockhash_slot: bslot,
            writable,
        });
        Ok(sig)
    }

    /// Simulates against the current state (with the loaded-data check).
    pub fn simulate(&self, wire: &[u8], sig_verify: bool) -> Result<SimResult, SendError> {
        self.simulate_full(wire, sig_verify).map(|(r, _, _, _)| r)
    }

    /// As [`Chain::simulate`], plus the error's JSON form, the return data
    /// and the inner-instruction count (for `simulateTransaction`).
    pub fn simulate_full(
        &self,
        wire: &[u8],
        sig_verify: bool,
    ) -> Result<(SimResult, Value, Vec<u8>, Option<Address>), SendError> {
        let t = self.txn(wire)?;
        if sig_verify {
            Self::verify(&t)?;
        }
        let keys = t.keys.clone();
        let limit = t.budget().effective_loaded_limit() as u64;
        let need = self.loaded_size(&t.view);
        if need > limit {
            return Ok((
                SimResult {
                    err: Some("MaxLoadedAccountsDataSizeExceeded".into()),
                    code: None,
                    logs: vec![],
                    units: 0,
                    accounts: keys.iter().map(|k| (*k, self.account(k))).collect(),
                },
                Value::String("MaxLoadedAccountsDataSizeExceeded".into()),
                vec![],
                None,
            ));
        }
        let post_state = |post: &[(Address, solana_account::AccountSharedData)]| -> Vec<(Address, Option<Account>)> {
            keys.iter()
                .map(|k| {
                    let a = post.iter().find(|(x, _)| x == k).map(|(_, a)| to_account(SolAccount::from(a.clone()))).or_else(|| self.account(k));
                    (*k, a)
                })
                .collect()
        };
        Ok(match self.svm.simulate_transaction(t.versioned()) {
            Ok(info) => {
                let rd = info.meta.return_data.clone();
                (
                    SimResult {
                        err: None,
                        code: None,
                        logs: info.meta.logs,
                        units: info.meta.compute_units_consumed,
                        accounts: post_state(&info.post_accounts),
                    },
                    Value::Null,
                    rd.data,
                    Some(rd.program_id),
                )
            }
            Err(f) => {
                let err = format!("{:?}", f.err);
                let rd = f.meta.return_data.clone();
                (
                    SimResult {
                        code: fclient::ports::custom_code(&err),
                        err: Some(err),
                        logs: f.meta.logs,
                        units: f.meta.compute_units_consumed,
                        accounts: post_state(&[]),
                    },
                    err_value!(&f.err),
                    rd.data,
                    Some(rd.program_id),
                )
            }
        })
    }

    /// Charges `fee` to the fee payer without executing (a failed load).
    fn charge(&mut self, payer: &Address, fee: u64) -> bool {
        let Some(mut a) = self.svm.get_account(payer) else {
            return false;
        };
        if a.lamports < fee {
            return false;
        }
        a.lamports -= fee;
        self.svm.set_account(*payer, a).is_ok()
    }

    /// Executes one transaction against the current state. `None` = refused
    /// without a charge (the fee payer cannot pay, or signatures fail).
    fn execute(&mut self, t: Txn, wire: Vec<u8>) -> Option<Landed> {
        let sig = t.signature();
        // herald-v0v1-decode: a v0 transaction's lookups resolve against the
        // state it executes on (agave loads them at execution, not at
        // admission); one that no longer resolves is not executable.
        let t = match self.resolve_lookups(&t.d) {
            Ok(l) if l == t.loaded => t,
            Ok(_) => match self.txn(&wire) {
                Ok(t) => t,
                Err(_) => {
                    self.dropped.insert(sig);
                    return None;
                }
            },
            Err(_) => {
                self.dropped.insert(sig);
                return None;
            }
        };
        let keys = t.keys.clone();
        let loaded = t.loaded.clone();
        let fee = t.fee();
        let limit = t.budget().effective_loaded_limit() as u64;
        let need = self.loaded_size(&t.view);
        let slot = self.slot;
        let block_time = self.unix_timestamp();
        let writable = t.writable();
        let pre_balances: Vec<u64> = keys.iter().map(|k| self.balance(k)).collect();
        let (logs, err, err_json, units, fee, ret) = if need > limit {
            if !self.charge(&keys[0], fee) {
                self.dropped.insert(sig);
                return None;
            }
            (
                vec![format!(
                    "frontier-localnet: loaded {need} B > limit {limit} B (SIMD-0186)"
                )],
                Some("MaxLoadedAccountsDataSizeExceeded".to_string()),
                Value::String("MaxLoadedAccountsDataSizeExceeded".into()),
                0,
                fee,
                vec![],
            )
        } else {
            match self.svm.send_transaction(t.versioned()) {
                Ok(m) => (
                    m.logs,
                    None,
                    Value::Null,
                    m.compute_units_consumed,
                    m.fee,
                    m.return_data.data,
                ),
                Err(f) => {
                    let e = format!("{:?}", f.err);
                    if e.contains("InsufficientFundsForFee")
                        || e.contains("AccountNotFound")
                        || e.contains("SignatureFailure")
                        // a lookup the runtime refuses (a table not active, an
                        // address extended this slot): never included (agave)
                        || e.contains("AddressLookupTable")
                        || e.contains("SanitizeFailure")
                    {
                        self.dropped.insert(sig);
                        return None;
                    }
                    (
                        f.meta.logs,
                        Some(e),
                        err_value!(&f.err),
                        f.meta.compute_units_consumed,
                        f.meta.fee,
                        f.meta.return_data.data,
                    )
                }
            }
        };
        let code = err.as_deref().and_then(fclient::ports::custom_code);
        let post = writable.iter().map(|k| (*k, self.account(k))).collect();
        let post_balances = keys.iter().map(|k| self.balance(k)).collect();
        let seq = self.landed.len() as u64 + 1;
        Some(Landed {
            airdrop: false,
            seq,
            slot,
            block_time,
            signature: sig,
            wire,
            keys,
            loaded,
            logs,
            err,
            err_json,
            code,
            units,
            fee,
            post,
            return_data: ret,
            pre_balances,
            post_balances,
        })
    }

    // ------------------------------------------------------------ contention emulator

    /// Holds `keys` (≤ 64) at `priority_milli` for the next `slots` slots.
    pub fn hold(
        &mut self,
        keys: Vec<Address>,
        priority_milli: u64,
        slots: u64,
    ) -> Result<Hold, String> {
        if keys.is_empty() || keys.len() > MAX_LOCKS {
            return Err(format!(
                "a hold names 1..={MAX_LOCKS} keys (a transaction's lock limit)"
            ));
        }
        if slots == 0 {
            return Err("a hold lasts at least one slot".into());
        }
        let mut keys = keys;
        keys.sort();
        keys.dedup();
        let h = Hold {
            id: self.next_hold,
            keys,
            priority_milli,
            from_slot: self.slot + 1,
            until_slot: self.slot + slots,
            filled_cu: 0,
            notional_lamports: 0,
        };
        self.next_hold += 1;
        self.holds.push(h.clone());
        Ok(h)
    }

    /// Ends a hold early; returns it (with its totals) if it existed.
    pub fn release(&mut self, id: u64) -> Option<Hold> {
        let i = self.holds.iter().position(|h| h.id == id)?;
        Some(self.holds.remove(i))
    }

    /// Holds not yet expired (and those that ended in the last slot).
    pub fn holds(&self) -> &[Hold] {
        &self.holds
    }

    /// Applies hold `i`'s filler to this block's budgets.
    fn fill_hold(
        &mut self,
        i: usize,
        block_cu: &mut u64,
        per_account: &mut HashMap<Address, u64>,
    ) -> u64 {
        let h = &mut self.holds[i];
        let room = BLOCK_CU.saturating_sub(*block_cu);
        let mut taken = 0u64;
        for k in &h.keys {
            let used = per_account.entry(*k).or_default();
            let fill = ACCOUNT_CU.saturating_sub(*used).min(room);
            *used += fill;
            taken = taken.max(fill);
        }
        *block_cu += taken;
        h.filled_cu += taken;
        let cost =
            u64::try_from(taken as u128 * h.priority_milli as u128 / 1_000).unwrap_or(u64::MAX);
        h.notional_lamports = h.notional_lamports.saturating_add(cost);
        taken
    }

    // ------------------------------------------------------------ blocks

    /// Produces one block: advances the slot and the Clock (`0.4 × scale`
    /// game seconds), then executes the mempool by priority under the caps
    /// and the holds, records the block in the ledger, publishes events and
    /// takes the periodic snapshot.
    pub fn produce_block(&mut self) -> BlockReport {
        if let Some(s) = self.pending_scale.take() {
            self.scale = s;
        }
        self.slot += 1;
        self.game_ms += (SLOT_MS as f64 * self.scale).round() as i64;
        self.write_clock();
        self.advance_blockhash();
        self.block_times.insert(self.slot, self.unix_timestamp());
        let mut report = BlockReport {
            slot: self.slot,
            unix_timestamp: self.unix_timestamp(),
            ..Default::default()
        };

        // Active holds, highest priority first.
        self.holds.retain(|h| h.until_slot >= self.slot);
        let mut active: Vec<usize> = (0..self.holds.len())
            .filter(|&i| self.holds[i].from_slot <= self.slot)
            .collect();
        active.sort_by(|&a, &b| {
            self.holds[b]
                .priority_milli
                .cmp(&self.holds[a].priority_milli)
                .then(self.holds[a].id.cmp(&self.holds[b].id))
        });
        let mut next_hold = 0usize;

        let mut pool = std::mem::take(&mut self.mempool);
        pool.sort_by(|a, b| {
            b.priority_milli
                .cmp(&a.priority_milli)
                .then(a.arrival.cmp(&b.arrival))
        });
        let mut per_account: HashMap<Address, u64> = HashMap::new();
        let mut block_cu = 0u64;
        let mut entries: Vec<Landed> = vec![];
        for p in pool {
            // Every hold at or above this priority fills first (ties: the hold).
            while next_hold < active.len()
                && self.holds[active[next_hold]].priority_milli >= p.priority_milli
            {
                report.hold_cu +=
                    self.fill_hold(active[next_hold], &mut block_cu, &mut per_account);
                next_hold += 1;
            }
            if p.blockhash_slot + BLOCKHASH_SLOTS < self.slot {
                report.dropped += 1;
                self.dropped.insert(p.tx.signature());
                continue;
            }
            let fits = block_cu + p.cost <= BLOCK_CU
                && p.writable
                    .iter()
                    .all(|k| per_account.get(k).copied().unwrap_or(0) + p.cost <= ACCOUNT_CU);
            if !fits {
                report.deferred += 1;
                self.mempool.push(p);
                continue;
            }
            let (cost, writable) = (p.cost, p.writable.clone());
            match self.execute(p.tx, p.wire) {
                Some(mut l) => {
                    block_cu += cost;
                    for k in &writable {
                        *per_account.entry(*k).or_default() += cost;
                    }
                    if l.err.is_some() {
                        report.failed += 1;
                    } else {
                        report.landed += 1;
                    }
                    l.seq = self.landed.len() as u64 + entries.len() as u64 + 1;
                    entries.push(l);
                }
                // Not executable at block time (not charged): it takes no
                // room in the block (integ-W2 review of W2-C).
                None => report.dropped += 1,
            }
        }
        while next_hold < active.len() {
            report.hold_cu += self.fill_hold(active[next_hold], &mut block_cu, &mut per_account);
            next_hold += 1;
        }
        report.cu = block_cu;
        self.commit_block(entries);
        self.maybe_snapshot();
        report
    }

    /// Makes a block durable (ledger first), then visible.
    fn commit_block(&mut self, entries: Vec<Landed>) {
        if self.wal.is_some() {
            let rec = Record::Block {
                slot: self.slot,
                game_ms: self.game_ms,
                scale: self.scale,
                txs: entries.iter().map(Landed::entry).collect(),
            };
            self.record(&rec);
        }
        let listen = self.events.receiver_count() > 0;
        if listen {
            let _ = self.events.send(Arc::new(Event::Slot(self.slot)));
        }
        for l in entries {
            if !listen {
                self.push_landed(l);
                continue;
            }
            let _ = self.events.send(Arc::new(Event::Tx {
                slot: l.slot,
                signature: l.signature,
                err: l.err_json.clone(),
                logs: l.logs.clone(),
                keys: l.keys.clone(),
            }));
            self.push_landed(l);
        }
    }

    // ------------------------------------------------------------ snapshots and restore

    /// Every account, sorted by address.
    pub fn all_accounts(&self) -> Vec<(Address, Account)> {
        let mut v: Vec<(Address, Account)> = self
            .svm
            .accounts_db()
            .inner
            .iter()
            .map(|(k, a)| (*k, to_account(SolAccount::from(a.clone()))))
            .collect();
        v.sort_by_key(|a| a.0);
        v
    }

    /// sha256 over the slot, the game clock and every account (address,
    /// lamports, owner, executable, data), in address order.
    pub fn state_hash(&self) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"PSF-LOCALNET-STATE-v1");
        h.update(self.slot.to_le_bytes());
        h.update(self.game_ms.to_le_bytes());
        for (k, a) in self.all_accounts() {
            h.update(k.as_ref());
            h.update(a.lamports.to_le_bytes());
            h.update(a.owner.as_ref());
            h.update([a.executable as u8]);
            h.update((a.data.len() as u64).to_le_bytes());
            h.update(&a.data);
        }
        h.finalize().into()
    }

    fn snapshot_value(&self) -> Snapshot {
        Snapshot {
            run_id: self.run_id,
            slot: self.slot,
            game_ms: self.game_ms,
            scale: self.scale,
            next_snapshot_ms: self.next_snapshot_ms,
            blockhashes: self.blockhashes.iter().copied().collect(),
            wal_offset: self.wal_offset(),
            landed_len: self.landed.len() as u64,
            last_sig: self.landed.last().map(|l| l.signature).unwrap_or_default(),
            accounts: self.all_accounts(),
        }
    }

    /// Writes a snapshot to `path`, or to `snap-<slot>.bin` in the data dir.
    pub fn snapshot(&mut self, path: Option<&Path>) -> Result<SnapInfo, String> {
        let path = match (path, &self.cfg.data_dir) {
            (Some(p), _) => p.to_path_buf(),
            (None, Some(d)) => persist::snapshot_path(d, self.slot),
            (None, None) => return Err("no data dir: name a snapshot path".into()),
        };
        let s = self.snapshot_value();
        let b = s.encode();
        s.write(&path)?;
        if let Some(d) = self.cfg.data_dir.clone() {
            for (_, old) in persist::snapshots_in(&d)
                .into_iter()
                .skip(self.cfg.keep_snapshots.max(1))
            {
                let _ = std::fs::remove_file(old);
            }
        }
        Ok(SnapInfo {
            slot: self.slot,
            path,
            state_hash: self.state_hash(),
            accounts: s.accounts.len(),
            bytes: b.len() as u64,
        })
    }

    fn maybe_snapshot(&mut self) {
        if self.cfg.data_dir.is_none() || self.game_ms < self.next_snapshot_ms {
            return;
        }
        let every = self.cfg.snapshot_every_secs.max(1) * 1_000;
        while self.next_snapshot_ms <= self.game_ms {
            self.next_snapshot_ms += every;
        }
        if let Err(e) = self.snapshot(None) {
            // The ledger alone still restores; a failed snapshot only
            // lengthens the next restore.
            eprintln!(
                "frontier-localnet: snapshot at slot {} failed: {e}",
                self.slot
            );
        }
    }

    /// Replaces the account state with the snapshot's.
    fn apply_snapshot(&mut self, s: &Snapshot) -> Result<(), String> {
        let want: HashSet<Address> = s.accounts.iter().map(|(k, _)| *k).collect();
        let stale: Vec<Address> = self
            .svm
            .accounts_db()
            .inner
            .keys()
            .filter(|k| !want.contains(k))
            .copied()
            .collect();
        for k in stale {
            self.set_inner(k, None)?;
        }
        // ProgramData before the programs that load it.
        for exec in [false, true] {
            for (k, a) in s.accounts.iter().filter(|(_, a)| a.executable == exec) {
                self.set_inner(*k, Some(a.clone()))?;
            }
        }
        self.slot = s.slot;
        self.game_ms = s.game_ms;
        self.scale = s.scale;
        self.next_snapshot_ms = s.next_snapshot_ms;
        self.blockhashes = s.blockhashes.iter().copied().collect();
        self.write_clock();
        Ok(())
    }

    /// Rewinds the chain to a snapshot of this run (`frontier_restore`): the
    /// state, the history and the ledger go back to the snapshot's point;
    /// the mempool, holds and later snapshots are discarded.
    pub fn restore(&mut self, path: &Path) -> Result<SnapInfo, String> {
        self.restore_with(path, os_entropy32)
    }

    /// [`Chain::restore`] with an injected entropy source (tests). Every
    /// validation, the snapshot's application to a temporary chain and the
    /// entropy come first, so their failures change nothing; the fresh
    /// instance is set immediately before the first state swap, so a later
    /// failure (e.g. the WAL truncate) already reports the new instance.
    fn restore_with(
        &mut self,
        path: &Path,
        entropy: impl FnOnce() -> Result<[u8; 32], String>,
    ) -> Result<SnapInfo, String> {
        let s = Snapshot::read(path)?;
        if s.run_id != self.run_id {
            return Err("snapshot of another run".into());
        }
        let n = s.landed_len as usize;
        let same_timeline = n <= self.landed.len()
            && (n == 0 && s.last_sig == Signature::default()
                || n > 0 && self.landed[n - 1].signature == s.last_sig);
        if !same_timeline || s.wal_offset > self.wal_offset() {
            return Err("snapshot is not on this chain's timeline".into());
        }
        let mut fresh = Chain::fresh(self.cfg.clone(), self.run_id, self.status_instance);
        fresh.apply_snapshot(&s)?;
        let next_instance = checked_instance(entropy()?)?;
        self.status_instance = next_instance;
        std::mem::swap(&mut self.svm, &mut fresh.svm);
        self.slot = s.slot;
        self.game_ms = s.game_ms;
        self.scale = s.scale;
        self.pending_scale = None;
        self.next_snapshot_ms = s.next_snapshot_ms;
        self.blockhashes = s.blockhashes.iter().copied().collect();
        self.landed.truncate(n);
        self.by_sig = self
            .landed
            .iter()
            .enumerate()
            .map(|(i, l)| (l.signature, i))
            .collect();
        self.block_times.retain(|sl, _| *sl <= s.slot);
        self.blocks.retain(|sl, _| *sl <= s.slot);
        self.mempool.clear();
        self.dropped.clear();
        self.holds.clear();
        if let Some(w) = self.wal.as_mut() {
            w.truncate(s.wal_offset)?;
        }
        if let Some(d) = self.cfg.data_dir.clone() {
            for (slot, p) in persist::snapshots_in(&d) {
                if slot > s.slot {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
        Ok(SnapInfo {
            slot: s.slot,
            path: path.to_path_buf(),
            state_hash: self.state_hash(),
            accounts: s.accounts.len(),
            bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        })
    }

    /// A ledger record the snapshot already includes: history only.
    fn load_history(&mut self, rec: Record) {
        match rec {
            Record::Block {
                slot, game_ms, txs, ..
            } => {
                let bt = game_ms.div_euclid(1_000);
                self.block_times.insert(slot, bt);
                for e in txs {
                    let seq = self.landed.len() as u64 + 1;
                    self.push_landed(Landed::from_entry(e, seq, slot, bt));
                }
            }
            Record::Airdrop {
                slot,
                lamports,
                signature,
                wire,
                ..
            } => {
                let seq = self.landed.len() as u64 + 1;
                let l = self.airdrop_landed(seq, slot, signature, wire, 0, lamports);
                self.push_landed(l);
            }
            Record::Deploy { .. } | Record::SetAccount { .. } => {}
        }
    }

    /// A ledger record after the snapshot: re-executed; the outcome must
    /// equal the recorded one.
    fn replay(&mut self, rec: Record) -> Result<(), String> {
        match rec {
            Record::Block {
                slot,
                game_ms,
                scale,
                txs,
            } => {
                if slot <= self.slot {
                    return Err(format!("ledger block {slot} not after slot {}", self.slot));
                }
                self.slot = slot;
                self.game_ms = game_ms;
                self.scale = scale;
                self.write_clock();
                self.advance_blockhash();
                self.block_times.insert(slot, self.unix_timestamp());
                while self.game_ms >= self.next_snapshot_ms {
                    self.next_snapshot_ms += self.cfg.snapshot_every_secs.max(1) * 1_000;
                }
                for e in txs {
                    let t = self.txn(&e.wire).map_err(|x| format!("ledger tx: {x}"))?;
                    let got = self.execute(t, e.wire.clone()).ok_or_else(|| {
                        format!("slot {slot}: {} was refused on replay", e.signature)
                    })?;
                    let g = got.entry();
                    if g != e {
                        return Err(format!(
                            "slot {slot}: {} replays differently (recorded err {:?} units {}, now err {:?} units {})",
                            e.signature, e.err, e.units, g.err, g.units
                        ));
                    }
                    let mut l = got;
                    l.seq = self.landed.len() as u64 + 1;
                    self.push_landed(l);
                }
                Ok(())
            }
            Record::Airdrop {
                key,
                lamports,
                signature,
                wire,
                ..
            } => self.apply_airdrop(&key, lamports, signature, wire),
            Record::Deploy {
                program,
                max_len,
                authority,
                so,
            } => self.deploy_inner(program, &so, max_len as usize, authority),
            Record::SetAccount { key, account } => self.set_inner(key, account),
        }
    }

    // ------------------------------------------------------------ queries

    pub fn status(&self, sig: &Signature) -> Option<Status> {
        let l = &self.landed[*self.by_sig.get(sig)?];
        Some(Status {
            slot: l.slot,
            err: l.err.clone(),
            code: l.code,
        })
    }

    /// The block of `slot` as `getBlock` serves it: its blockhash, parent
    /// slot, the parent's blockhash and its transactions' signatures in
    /// ledger order. Only slots a transaction landed in (an empty slot has
    /// no block here), and not history loaded from a snapshot.
    pub fn block(&self, slot: u64) -> Option<(Hash, u64, Hash, Vec<Signature>)> {
        let &(h, ps, ph) = self.blocks.get(&slot)?;
        let sigs = self
            .landed
            .iter()
            .filter(|l| l.slot == slot)
            .map(|l| l.signature)
            .collect();
        Some((h, ps, ph, sigs))
    }

    pub fn transaction(&self, sig: &Signature) -> Option<&Landed> {
        self.by_sig.get(sig).map(|&i| &self.landed[i])
    }

    /// Transactions that mention `program` (incl. failed), after feed seq `after`.
    pub fn feed(&self, after: u64, limit: usize, program: Option<&Address>) -> Vec<&Landed> {
        self.landed
            .iter()
            .skip(after as usize)
            .filter(|l| !l.airdrop && program.is_none_or(|p| l.keys.contains(p)))
            .take(limit)
            .collect()
    }

    /// [`Chain::feed`] and, read in the same call (under the node's lock, so
    /// nothing lands in between), how far the ledger was scanned for it
    /// (workstream 04, 2026-11-07): see [`FeedScan`].
    pub fn feed_scan(
        &self,
        after: u64,
        limit: usize,
        program: Option<&Address>,
    ) -> (Vec<&Landed>, FeedScan) {
        let (idx, scan) = scan_ledger(self.landed.len(), after, limit, |i| {
            let l = &self.landed[i];
            !l.airdrop && program.is_none_or(|p| l.keys.contains(p))
        });
        let at_after = (after > 0)
            .then(|| self.landed.get(after as usize - 1))
            .flatten()
            .map(|l| l.signature);
        (
            idx.into_iter().map(|i| &self.landed[i]).collect(),
            FeedScan { at_after, ..scan },
        )
    }

    /// Newest first, as `getSignaturesForAddress`: strictly older than
    /// `before`, stopping at (excluding) `until`.
    pub fn signatures_for(
        &self,
        k: &Address,
        limit: usize,
        before: Option<&Signature>,
        until: Option<&Signature>,
    ) -> Vec<&Landed> {
        let start = match before {
            Some(b) => match self.by_sig.get(b) {
                Some(&i) => i,
                None => return vec![],
            },
            None => self.landed.len(),
        };
        let mut out = vec![];
        for l in self.landed[..start].iter().rev() {
            if until.is_some_and(|u| *u == l.signature) {
                break;
            }
            if l.keys.contains(k) {
                out.push(l);
                if out.len() >= limit {
                    break;
                }
            }
        }
        out
    }

    pub fn pending(&self) -> usize {
        self.mempool.len()
    }

    pub fn transaction_count(&self) -> u64 {
        self.landed.len() as u64
    }

    pub fn is_dropped(&self, sig: &Signature) -> bool {
        self.dropped.contains(sig)
    }
}

/// How far one feed read scanned the ledger (workstream 04, 2026-11-07),
/// read with its records in one call.
///
/// - `scanned_through`: every ledger entry with `after < seq <= scanned_through`
///   was examined; the records returned are all of those that matched. It is
///   the last returned record's seq when the read stopped at `limit`, else
///   the ledger's length (the whole tail was examined).
/// - `ledger_len`: the ledger's length at the read. Less than `after`: the
///   ledger is shorter than the reader's cursor (rewound or rebuilt).
/// - `at_after`: the signature of ledger entry `after` (`None` for 0 or when
///   the ledger has no such entry). A reader that archived that entry checks
///   it is still the same transaction there (not rewound).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedScan {
    pub scanned_through: u64,
    pub ledger_len: u64,
    pub at_after: Option<Signature>,
}

/// The scan of a ledger of `len` entries (seq = index + 1) after `after`,
/// keeping up to `limit` indexes for which `keep` holds: the kept indexes and
/// the extent examined ([`FeedScan`], `at_after` not set).
pub fn scan_ledger(
    len: usize,
    after: u64,
    limit: usize,
    keep: impl Fn(usize) -> bool,
) -> (Vec<usize>, FeedScan) {
    let mut out = vec![];
    let mut scanned = len as u64;
    for i in (after as usize).min(len)..len {
        if out.len() == limit {
            break;
        }
        if keep(i) {
            out.push(i);
            if out.len() == limit {
                scanned = i as u64 + 1;
                break;
            }
        }
    }
    if limit == 0 {
        scanned = after.min(len as u64);
    }
    (
        out,
        FeedScan {
            scanned_through: scanned,
            ledger_len: len as u64,
            at_after: None,
        },
    )
}

#[cfg(test)]
mod feed_scan_tests {
    use super::scan_ledger;

    /// The ledger 1..=8; entries 2, 4, 5 and 8 are the program's.
    fn mine(i: usize) -> bool {
        [1, 3, 4, 7].contains(&i)
    }

    #[test]
    fn the_whole_tail_is_scanned_when_the_limit_is_not_reached() {
        let (idx, s) = scan_ledger(8, 0, 100, mine);
        assert_eq!(idx, vec![1, 3, 4, 7]);
        assert_eq!((s.scanned_through, s.ledger_len), (8, 8));
        // After the program's last entry: still scanned to the end.
        let (idx, s) = scan_ledger(8, 5, 100, mine);
        assert_eq!(idx, vec![7]);
        assert_eq!(s.scanned_through, 8);
        // Nothing of the program left: the tail was still examined.
        let (idx, s) = scan_ledger(9, 8, 100, mine);
        assert!(idx.is_empty());
        assert_eq!(s.scanned_through, 9);
    }

    #[test]
    fn a_read_cut_by_its_limit_scanned_only_to_its_last_record() {
        let (idx, s) = scan_ledger(8, 0, 2, mine);
        assert_eq!(idx, vec![1, 3]);
        assert_eq!(s.scanned_through, 4, "seq of index 3");
        let (idx, s) = scan_ledger(8, 4, 2, mine);
        assert_eq!(idx, vec![4, 7]);
        assert_eq!(s.scanned_through, 8);
        assert_eq!(scan_ledger(8, 3, 0, mine).1.scanned_through, 3);
    }

    #[test]
    fn a_cursor_past_the_ledger_shows_a_shorter_ledger() {
        let (idx, s) = scan_ledger(5, 7, 100, mine);
        assert!(idx.is_empty());
        assert_eq!((s.scanned_through, s.ledger_len), (5, 5));
        assert!(
            s.scanned_through < 7,
            "the reader sees its cursor is past the ledger"
        );
    }
}

/// F2: the runtime-only runner instance (`status_instance`).
#[cfg(test)]
mod status_instance_tests {
    use super::*;

    const A: [u8; 32] = [7; 32];
    const B: [u8; 32] = [9; 32];

    /// A NEW directory this test owns (create_dir refuses an existing path);
    /// only it is removed afterwards.
    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        for n in 0..1000u32 {
            let d = std::env::temp_dir().join(format!(
                "localnet-instance-{}-{name}-{nanos}-{n}",
                std::process::id()
            ));
            if std::fs::create_dir(&d).is_ok() {
                return d;
            }
        }
        panic!("no fresh scratch directory")
    }
    fn disk(d: &Path) -> Config {
        Config {
            data_dir: Some(d.to_path_buf()),
            fsync: false,
            snapshot_every_secs: 1_000_000,
            ..Config::default()
        }
    }
    fn err_of(r: Result<Chain, String>) -> String {
        match r {
            Err(e) => e,
            Ok(_) => panic!("expected an error"),
        }
    }
    fn fail() -> Result<[u8; 32], String> {
        Err("no entropy".into())
    }
    fn zero() -> Result<[u8; 32], String> {
        Ok([0; 32])
    }
    fn bump(c: &mut Chain, k: u8) {
        c.airdrop(&Address::new_from_array([k; 32]), 5).unwrap();
        c.produce_block();
    }

    #[test]
    fn real_entropy_gives_distinct_nonzero_instances() {
        let (a, b) = (Chain::new(Config::default()), Chain::new(Config::default()));
        assert_ne!(a.status_instance(), [0; 32]);
        assert_ne!(a.status_instance(), b.status_instance());
    }

    #[test]
    fn open_refuses_failing_or_zero_entropy_on_every_path() {
        // memory-only
        assert!(err_of(Chain::open_with(Config::default(), fail)).contains("no entropy"));
        assert!(err_of(Chain::open_with(Config::default(), zero)).contains("all zero"));
        // new ledger: nothing is created
        let root = scratch("open");
        let d = root.join("ledger");
        assert!(err_of(Chain::open_with(disk(&d), fail)).contains("no entropy"));
        assert!(!d.exists(), "no ledger directory was created");
        // recovered ledger: refused, the ledger stays intact and reopens
        let mut c = Chain::open_with(disk(&d), || Ok(A)).unwrap();
        bump(&mut c, 1);
        let h = c.state_hash();
        drop(c);
        assert!(err_of(Chain::open_with(disk(&d), zero)).contains("all zero"));
        let c = Chain::open_with(disk(&d), || Ok(B)).unwrap();
        assert_eq!(c.state_hash(), h);
        assert_eq!(c.status_instance(), B);
        drop(c);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_instance_never_enters_persisted_or_hashed_identity() {
        let a = Chain::open_with(Config::default(), || Ok(A)).unwrap();
        let b = Chain::open_with(Config::default(), || Ok(B)).unwrap();
        assert_eq!((a.status_instance(), b.status_instance()), (A, B));
        assert_eq!(a.state_hash(), b.state_hash());
        assert_eq!(a.latest_blockhash(), b.latest_blockhash());
        // Snapshot bytes do not depend on the instance: two chains with the
        // SAME run id (set before any byte is produced; test-only use of the
        // private constructor) and different instances, same history, give
        // byte-identical snapshots. The production encoder is unchanged.
        let root = scratch("snapbytes");
        let run = [3u8; 16];
        let mut a = Chain::fresh(Config::default(), run, A);
        let mut b = Chain::fresh(Config::default(), run, B);
        bump(&mut a, 1);
        bump(&mut b, 1);
        let (pa, pb) = (root.join("a.bin"), root.join("b.bin"));
        a.snapshot(Some(&pa)).unwrap();
        b.snapshot(Some(&pb)).unwrap();
        let (ba, bb) = (std::fs::read(&pa).unwrap(), std::fs::read(&pb).unwrap());
        let short = |v: &[u8]| hex::encode(&persist::sha256(&[v])[..8]);
        let first_diff = ba.iter().zip(&bb).position(|(x, y)| x != y);
        assert!(
            ba.len() == bb.len() && first_diff.is_none(),
            "snapshot bytes differ: len {} vs {}, sha256[..8] {} vs {}, first differing offset {:?}",
            ba.len(),
            bb.len(),
            short(&ba),
            short(&bb),
            first_diff
        );
        assert!(
            !ba.windows(32).any(|w| w == A) && !bb.windows(32).any(|w| w == B),
            "instance bytes absent"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_failures_before_the_swap_change_nothing() {
        let root = scratch("restore-a");
        let mut c = Chain::open_with(Config::default(), || Ok(A)).unwrap();
        bump(&mut c, 1);
        let p = root.join("s.bin");
        let snap = c.snapshot(Some(&p)).unwrap();
        bump(&mut c, 2);
        let (h, n) = (c.state_hash(), c.transaction_count());
        // a snapshot of another run
        let mut other = Chain::open_with(Config::default(), || Ok(B)).unwrap();
        let q = root.join("other.bin");
        other.snapshot(Some(&q)).unwrap();
        assert!(c.restore_with(&q, || Ok(B)).is_err());
        // failing and all-zero entropy
        assert!(c.restore_with(&p, fail).unwrap_err().contains("no entropy"));
        assert!(c.restore_with(&p, zero).unwrap_err().contains("all zero"));
        assert_eq!(
            (c.status_instance(), c.state_hash(), c.transaction_count()),
            (A, h, n)
        );
        // success: new instance, the snapshot's state, the same run id
        let run = c.run_id();
        let r = c.restore_with(&p, || Ok(B)).unwrap();
        assert_eq!(r.state_hash, snap.state_hash);
        assert_eq!((c.status_instance(), c.run_id()), (B, run));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failing_wal_truncate_after_the_swap_reports_the_new_instance() {
        let root = scratch("restore-b");
        let d = root.join("ledger");
        let mut c = Chain::open_with(disk(&d), || Ok(A)).unwrap();
        bump(&mut c, 1);
        let snap = c.snapshot(None).unwrap();
        bump(&mut c, 2);
        c.wal.as_mut().unwrap().fail_next_truncate = true;
        let e = c.restore_with(&snap.path, || Ok(B)).unwrap_err();
        assert!(e.contains("test fault: WAL truncate"), "{e}");
        assert_eq!(c.status_instance(), B, "updated before the first swap");
        assert_eq!(
            c.state_hash(),
            snap.state_hash,
            "the state was already swapped"
        );
        drop(c);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// keeper-rent-floor: the Rent sysvar's rate is configurable (in memory).
#[cfg(test)]
mod rent_rate_tests {
    use super::*;

    fn sysvar_rate(c: &Chain) -> (u64, f64) {
        let id: Address = "SysvarRent111111111111111111111111111111111"
            .parse()
            .unwrap();
        let a = c.account(&id).expect("the Rent sysvar is an account");
        (
            u64::from_le_bytes(a.data[0..8].try_into().unwrap()),
            f64::from_le_bytes(a.data[8..16].try_into().unwrap()),
        )
    }

    #[test]
    fn the_default_is_5080_and_6960_can_be_chosen() {
        let c = Chain::new(Config::default());
        assert_eq!(
            c.svm.minimum_balance_for_rent_exemption(4_736),
            4_864 * 5_080
        );
        assert_eq!(sysvar_rate(&c), (5_080, 1.0));
        let c = Chain::new(Config {
            lamports_per_byte: 6_960,
            ..Config::default()
        });
        assert_eq!(
            c.svm.minimum_balance_for_rent_exemption(4_736),
            4_864 * 6_960
        );
        assert_eq!(sysvar_rate(&c), (6_960, 1.0));
    }

    #[test]
    fn another_rate_is_refused_for_a_persisted_chain_and_zero_always() {
        let e = Chain::open(Config {
            lamports_per_byte: 6_960,
            data_dir: Some(std::env::temp_dir().join("never-created-keeper-rent-floor")),
            ..Config::default()
        })
        .err()
        .unwrap();
        assert!(e.contains("in-memory chains only"), "{e}");
        assert!(!std::env::temp_dir()
            .join("never-created-keeper-rent-floor")
            .exists());
        assert!(Chain::open(Config {
            lamports_per_byte: 0,
            ..Config::default()
        })
        .is_err());
    }
}
