//! Re-execution of one archived transaction by the PINNED program binary
//! (Q16-1 = A, prize gate, 2026-11-19; the `playable-lane` build only).
//!
//! The playable lane's expedition wrapper (0xDA / 0xEE / 0xDC / 0xDF with
//! the dispatch envelope `[tag, 0xff, 2, kind]`, kinds 0–18: the
//! ExpeditionDepart / SettleOrigin / ExpeditionReveal / Gather / … member
//! settlements and the Free City conquest kinds 12–18) runs some 20,000
//! lines of `permutation-frontier` code. An independent port of each
//! handler (the way VWL re-judges the wide land) would be a second
//! unverified implementation of the same size. This module takes the
//! approach of a stateless block validator instead (reth's `stateless`
//! crate over an `ExecutionWitness`, agave `ledger-tool verify`): it loads
//! the very `.so` whose sha256 the verifier pins (V2) into a fresh LiteSVM,
//! puts every account the transaction names in the state the archive
//! itself shows before it (the post-state of the last earlier transaction
//! that wrote it, or the witness of a segment), sets the Clock to the
//! transaction's slot and time, and executes the archived transaction
//! bytes **as signed** (signatures verified, the recent blockhash not
//! checked). The judgement ([`crate::checks::vx_reexec`]) then compares the
//! outcome, the program's log lines and every program-owned post-state
//! with the archive.
//!
//! What this proves: given the states the archive shows before it, the
//! pinned program produces exactly the post-states and records the archive
//! claims. What it does not prove: anything about the program's own
//! correctness (the program IS the rule here), or the provenance of the
//! states it starts from (those are earlier transactions', judged by their
//! own checks, or declared witness/patches, which stay UNVERIFIABLE).

use std::collections::BTreeMap;

use fclient::ports::Account;
use litesvm::LiteSVM;
use solana_account::Account as SolAccount;
use solana_address::Address;

use crate::world::Key;

/// The pinned program binary and the chain parameters it ran under.
#[derive(Clone, Debug)]
pub struct Program {
    /// The `.so` bytes (sha256 must equal the pinned `program_hash`).
    pub so: std::sync::Arc<Vec<u8>>,
    /// The Rent sysvar the re-execution installs: the cluster's own
    /// (`Input::chain.rent`, [`rent_of`]) or, when no source stated it, the
    /// ASSUMED local-node default (5,080 lamports per byte, threshold 1.0),
    /// which the report says (rent-live-rest: never a silent constant).
    pub rent: fclient::rent::RentSysvar,
}

impl Program {
    /// The binary with the ASSUMED local-node rent ([`assumed_rent`]):
    /// tests, and callers that state the rent with [`Program::with_rent`].
    pub fn new(so: Vec<u8>) -> Program {
        Program::with_rent(so, assumed_rent())
    }
    /// The binary and the Rent sysvar the season ran under.
    pub fn with_rent(so: Vec<u8>, rent: fclient::rent::RentSysvar) -> Program {
        Program {
            so: std::sync::Arc::new(so),
            rent,
        }
    }
    /// Lamports per byte of the installed rent (`minimum_balance(0) / 128`).
    pub fn lamports_per_byte(&self) -> Option<u64> {
        rent_per_byte(&self.rent)
    }
    pub fn sha256(&self) -> [u8; 32] {
        permutation_rules::hash::sha256(&[&self.so])
    }
    /// Reads a `.so` or a gzip-compressed `.so.gz`.
    pub fn load(path: &std::path::Path) -> Result<Program, String> {
        let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let so = if raw.starts_with(&[0x1f, 0x8b]) {
            use std::io::Read;
            let mut out = vec![];
            flate2::read::GzDecoder::new(&raw[..])
                .read_to_end(&mut out)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            out
        } else {
            raw
        };
        Ok(Program::new(so))
    }
}

pub use crate::rent::{assumed_rent, rent_of, rent_per_byte, RentBasis, LAMPORTS_PER_BYTE};

/// The pinned binary of `input` (`--program-so`) with the rent it ran under.
pub fn program_of(input: &crate::input::Input) -> Option<Program> {
    let rent = rent_of(input).0;
    input
        .program_so
        .as_ref()
        .map(|so| Program::with_rent(so.as_ref().clone(), rent))
}

/// What a signer or another wallet the archive does not show is funded
/// with (its balance is never compared; only program-owned accounts are).
const WALLET_FUND: u64 = 1_000_000_000_000_000;

/// How one account entered the re-execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pre {
    /// The post-state of an earlier archived transaction (absent included).
    Archive,
    /// A state the archive declares (a recorder's patch,
    /// `Input::declared`), not one an archived transaction wrote.
    Declared,
    /// No state anywhere: taken as absent (a signer as a funded system
    /// wallet).
    Assumed,
    /// Supplied by the runtime (the program, its ProgramData, sysvars,
    /// builtins): not set.
    Runtime,
}

/// The re-executed transaction.
#[derive(Clone, Debug)]
pub struct Replayed {
    /// `None`: success; else the runtime's error (Debug form).
    pub err: Option<String>,
    pub logs: Vec<String>,
    /// Every message key with how its pre-state was taken, its pre-state
    /// and its post-state (`None`: absent).
    pub accounts: Vec<(Key, Pre, Option<Account>, Option<Account>)>,
    /// Whether the transaction names the program's ProgramData, whose
    /// upgrade authority (AnnounceSeason reads it) the archive does not
    /// show: the re-run's has none.
    pub names_programdata: bool,
}

/// A LiteSVM with the program deployed (LoaderV3, as the local node and a
/// real `solana program deploy` place it) and the node's rent; reused for
/// every transaction of a run (each one sets every account it names).
pub struct Svm {
    svm: LiteSVM,
    program: Address,
    programdata: Address,
}

fn loader_v3() -> Address {
    "BPFLoaderUpgradeab1e11111111111111111111111"
        .parse()
        .expect("the LoaderV3 id")
}

fn sysvar_owner() -> Address {
    "Sysvar1111111111111111111111111111111111111"
        .parse()
        .expect("the sysvar owner id")
}

impl Svm {
    pub fn new(p: &Program, program: &Address) -> Result<Svm, String> {
        Svm::with_authority(p, program, None)
    }

    /// [`Svm::new`] with the ProgramData's upgrade authority as the chain
    /// shows it (`Input::chain`; AnnounceSeason reads it). `None`: none.
    pub fn with_authority(
        p: &Program,
        program: &Address,
        authority: Option<Address>,
    ) -> Result<Svm, String> {
        let mut svm = LiteSVM::new()
            .with_sigverify(true)
            .with_blockhash_check(false)
            .with_log_bytes_limit(None)
            .with_transaction_history(0);
        // The season's Rent sysvar exactly (rent-live-rest): its rate, its
        // threshold and its burn share, as the program reads it.
        let mut rent: solana_rent::Rent = svm.get_sysvar();
        rent.lamports_per_byte = p.rent.lamports_per_byte_year;
        #[allow(deprecated)]
        {
            rent.exemption_threshold = p.rent.exemption_threshold.to_le_bytes();
            rent.burn_percent = p.rent.burn_percent;
        }
        svm.set_sysvar(&rent);
        let loader = loader_v3();
        let (programdata, _) = Address::find_program_address(&[program.as_ref()], &loader);
        // UpgradeableLoaderState::ProgramData { slot 0, authority }, then the ELF.
        let mut data = vec![0u8; 45 + p.so.len()];
        data[..4].copy_from_slice(&3u32.to_le_bytes());
        if let Some(a) = authority {
            data[12] = 1;
            data[13..45].copy_from_slice(a.as_ref());
        }
        data[45..].copy_from_slice(&p.so);
        let lamports = svm.minimum_balance_for_rent_exemption(data.len());
        svm.set_account(
            programdata,
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
        pdata[..4].copy_from_slice(&2u32.to_le_bytes());
        pdata[4..].copy_from_slice(programdata.as_ref());
        let lamports = svm.minimum_balance_for_rent_exemption(36);
        svm.set_account(
            *program,
            SolAccount {
                lamports,
                data: pdata,
                owner: loader,
                executable: true,
                rent_epoch: u64::MAX,
            },
        )
        .map_err(|e| format!("program: {e:?}"))?;
        Ok(Svm {
            svm,
            program: *program,
            programdata,
        })
    }

    /// Whether the runtime supplies `k` (never set from the archive).
    pub fn runtime(&self, k: &Address) -> bool {
        if *k == self.program || *k == self.programdata || k.to_string().starts_with("Sysvar") {
            return true;
        }
        self.svm
            .get_account(k)
            .is_some_and(|a| a.executable || a.owner == sysvar_owner())
    }

    /// The program's ProgramData (synthetic here: slot 0, the ELF unpadded).
    pub fn programdata(&self) -> Address {
        self.programdata
    }

    /// Gives the ProgramData the chain's lamports (a real deploy pads it to
    /// `max_len`, so it holds more rent than this one).
    pub fn set_programdata_lamports(&mut self, l: u64) -> Result<(), String> {
        let mut a = self
            .svm
            .get_account(&self.programdata)
            .ok_or("no ProgramData")?;
        a.lamports = l;
        self.svm
            .set_account(self.programdata, a)
            .map_err(|e| format!("programdata: {e:?}"))
    }

    /// The lamports the runtime gives `k` when it supplies it (the program,
    /// its ProgramData, sysvars, builtins); `None`: not the runtime's.
    pub fn runtime_lamports(&self, k: &Address) -> Option<u64> {
        self.runtime(k)
            .then(|| self.svm.get_account(k).map_or(0, |a| a.lamports))
    }

    fn get(&self, k: &Address) -> Option<Account> {
        self.svm
            .get_account(k)
            .filter(|a| a.lamports > 0 || !a.data.is_empty())
            .map(|a| Account {
                lamports: a.lamports,
                data: a.data,
                owner: a.owner,
                executable: a.executable,
            })
    }

    /// Executes `wire` (the archived legacy transaction bytes) at `slot` /
    /// `time` from the states `pre` gives for each message key:
    /// `Some((how, state))` (`None` state: absent), or `None` when nothing
    /// shows it (then [`Pre::Assumed`]).
    pub fn replay(
        &mut self,
        wire: &[u8],
        slot: u64,
        time: i64,
        pre: impl Fn(&Key) -> Option<(Pre, Option<Account>)>,
    ) -> Result<Replayed, String> {
        self.replay_with(wire, slot, time, pre, &BTreeMap::new())
    }

    /// [`Svm::replay`] with the lamports of some accounts given exactly
    /// (`exact`: never funded): the wallets whose balance before the
    /// transaction [`replay_exact`] back-computed.
    pub fn replay_with(
        &mut self,
        wire: &[u8],
        slot: u64,
        time: i64,
        pre: impl Fn(&Key) -> Option<(Pre, Option<Account>)>,
        exact: &BTreeMap<Key, u64>,
    ) -> Result<Replayed, String> {
        let t = fclient::tx::from_wire(wire)?;
        let keys = t.message.account_keys.clone();
        let signers = t.message.header.num_required_signatures as usize;
        let mut accounts = vec![];
        for (i, k) in keys.iter().enumerate() {
            if self.runtime(k) {
                accounts.push((k.to_bytes(), Pre::Runtime, None));
                continue;
            }
            // (Not judged by the curve: the program's seed-derived
            // addresses, `create_with_seed`, are on the curve half the time.)
            let (how, mut state) = match pre(&k.to_bytes()) {
                Some((how, s)) => (how, s),
                None => (Pre::Assumed, None),
            };
            if let Some(&l) = exact.get(&k.to_bytes()) {
                let s = state.get_or_insert(Account {
                    lamports: 0,
                    data: vec![],
                    owner: Address::default(),
                    executable: false,
                });
                s.lamports = l;
                accounts.push((k.to_bytes(), how, state.clone()));
                let sol = match &state {
                    Some(a) if a.lamports > 0 || !a.data.is_empty() => SolAccount {
                        lamports: a.lamports,
                        data: a.data.clone(),
                        owner: a.owner,
                        executable: a.executable,
                        rent_epoch: u64::MAX,
                    },
                    _ => SolAccount::default(),
                };
                self.svm
                    .set_account(*k, sol)
                    .map_err(|e| format!("set {k}: {e:?}"))?;
                continue;
            }
            // A signer pays fees and rent: its balance is not judged, so it
            // is never what makes the re-execution fail.
            if i < signers {
                let s = state.get_or_insert(Account {
                    lamports: 0,
                    data: vec![],
                    owner: Address::default(),
                    executable: false,
                });
                if s.data.is_empty() && s.owner == Address::default() {
                    s.lamports = s.lamports.max(WALLET_FUND);
                }
            }
            let sol = match &state {
                Some(a) => SolAccount {
                    lamports: a.lamports,
                    data: a.data.clone(),
                    owner: a.owner,
                    executable: a.executable,
                    rent_epoch: u64::MAX,
                },
                None => SolAccount::default(),
            };
            self.svm
                .set_account(*k, sol)
                .map_err(|e| format!("set {k}: {e:?}"))?;
            accounts.push((k.to_bytes(), how, state));
        }
        self.svm.set_sysvar(&solana_clock::Clock {
            slot,
            epoch_start_timestamp: time,
            epoch: 0,
            leader_schedule_epoch: 1,
            unix_timestamp: time,
        });
        let (err, logs) = match self.svm.send_transaction(t) {
            Ok(m) => (None, m.logs),
            Err(f) => (Some(format!("{:?}", f.err)), f.meta.logs),
        };
        let accounts = accounts
            .into_iter()
            .map(|(k, how, before)| {
                let after = if how == Pre::Runtime {
                    None
                } else {
                    self.get(&Address::new_from_array(k))
                };
                (k, how, before, after)
            })
            .collect();
        Ok(Replayed {
            err,
            logs,
            accounts,
            names_programdata: keys.contains(&self.programdata),
        })
    }
}

/// Re-executes twice when needed so that every WALLET the transaction
/// writes starts from its exact balance: the program's receipts digest
/// every named account's lamports (`expedition_event::digest`), and an
/// archive shows a wallet's balance only after a transaction (its own
/// earlier post-state can be stale: fees and transfers of other programs'
/// transactions are not in this program's archive). The first run gives
/// the program's lamport movement `d` of each such wallet; the second
/// starts it from `archived_post − d`. A wallet balance is therefore taken
/// from the archive's own claim, never proven (nor needed: no game state
/// rests on it); the game's accounts are compared exactly.
pub fn replay_exact(
    svm: &mut Svm,
    wire: &[u8],
    slot: u64,
    time: i64,
    pre: impl Fn(&Key) -> Option<(Pre, Option<Account>)>,
    posted: impl Fn(&Key) -> Option<Option<Account>>,
    program: &Key,
) -> Result<Replayed, String> {
    replay_known(svm, wire, slot, time, pre, posted, program, None)
}

/// [`replay_exact`] with every named account's lamports known before the
/// transaction (`known`: the chain's `meta.preBalances`, message key
/// order): each account starts from exactly them, and only the fee payer
/// is re-based when the runtime's fee differs from the chain's (`fee`:
/// the archived one), so that the program sees the balance the chain's
/// program saw. `None`: as [`replay_exact`].
#[allow(clippy::too_many_arguments)]
pub fn replay_known(
    svm: &mut Svm,
    wire: &[u8],
    slot: u64,
    time: i64,
    pre: impl Fn(&Key) -> Option<(Pre, Option<Account>)>,
    posted: impl Fn(&Key) -> Option<Option<Account>>,
    program: &Key,
    known: Option<(&[u64], &[u64], u64)>,
) -> Result<Replayed, String> {
    let t = fclient::tx::from_wire(wire)?;
    if let Some((pre_b, post_b, fee)) = known {
        let keys = &t.message.account_keys;
        if pre_b.len() != keys.len() || post_b.len() != keys.len() {
            return Err(format!(
                "the archived balances name {} / {} accounts, the message {}",
                pre_b.len(),
                post_b.len(),
                keys.len()
            ));
        }
        let mut exact: BTreeMap<Key, u64> = keys
            .iter()
            .zip(pre_b)
            .filter(|(k, _)| !svm.runtime(k))
            .map(|(k, &l)| (k.to_bytes(), l))
            .collect();
        let first = svm.replay_with(wire, slot, time, &pre, &exact)?;
        // The fee payer: the runtime's fee (LiteSVM's) against the chain's.
        if let (Some((k, Pre::Archive | Pre::Assumed | Pre::Declared, b, a)), Some(&p0)) =
            (first.accounts.first(), pre_b.first())
        {
            // Chain: p0 − post = its fee + what the instructions moved.
            // Replay from p0: LiteSVM's fee + what they moved. A difference
            // d is the fees' (same program, same movement): start the payer
            // at p0 + d, so that it holds p0 − the chain's fee while the
            // program runs, as on the chain.
            let moved = b.as_ref().map_or(0, |x| x.lamports) as i128
                - a.as_ref().map_or(0, |x| x.lamports) as i128;
            let d = moved - (p0 as i128 - post_b[0] as i128);
            let svm_fee = d + fee as i128;
            if d != 0 && first.err.is_none() && svm_fee >= 0 && p0 as i128 + d >= 0 {
                exact.insert(*k, (p0 as i128 + d) as u64);
                return svm.replay_with(wire, slot, time, &pre, &exact);
            }
        }
        return Ok(first);
    }
    let first = svm.replay(wire, slot, time, &pre)?;
    let mut exact = BTreeMap::new();
    for (i, (k, how, before, after)) in first.accounts.iter().enumerate() {
        if *how == Pre::Runtime || !fclient::tx::is_writable_index(&t.message, i) {
            continue;
        }
        let wallet = |a: &Option<Account>| {
            a.as_ref()
                .is_none_or(|a| a.owner.to_bytes() != *program && a.data.is_empty())
        };
        if !wallet(before) || !wallet(after) {
            continue;
        }
        let Some(Some(rec)) = posted(k) else { continue };
        if rec.owner.to_bytes() == *program || !rec.data.is_empty() {
            continue;
        }
        let b = before.as_ref().map_or(0, |a| a.lamports) as i128;
        let a = after.as_ref().map_or(0, |a| a.lamports) as i128;
        let want = rec.lamports as i128 - (a - b);
        if want >= 0 && want != b {
            exact.insert(*k, want as u64);
        }
    }
    if exact.is_empty() {
        return Ok(first);
    }
    svm.replay_with(wire, slot, time, &pre, &exact)
}

/// The log lines the comparison reads: all but the runtime's compute-unit
/// accounting (`Program … consumed N of M compute units`), which depends on
/// the cluster's cost tables, not on the program's effects.
pub fn judged_logs(logs: &[String]) -> Vec<&str> {
    logs.iter()
        .map(|s| s.as_str())
        .filter(|l| {
            !(l.starts_with("Program ")
                && l.contains(" consumed ")
                && l.ends_with(" compute units"))
        })
        .collect()
}
