//! What the verifier is given (contract §8.5): the program id, the season
//! id, the pinned drand public key, the ruleset hash expected, optionally
//! the `.so` hash expected; the season's transactions (feed order, failed
//! ones included) and the **final account states at a pinned slot**.
//!
//! Three sources give the same [`Input`]:
//!
//! - a **fixture file** (`frontier-node/fixtures/verify/*.json`): a
//!   recorded mini-season, the transactions in `findex`'s archive JSON
//!   form and the final accounts in RPC JSON form;
//! - a **findex archive** directory (`--archive`, a speed-up only) plus
//!   the final accounts fetched from RPC or read from a file;
//! - **RPC** alone (`--rpc`): the program's transactions through `findex`'s
//!   `RpcPoll` (or `frontier_feed` on a local node) and every account the
//!   season wrote read back at the newest slot.
//!
//! The final states are read, never trusted from the archive (K4): the
//! archive's post-states are used to replay, the finals to end every chain.

use std::collections::BTreeMap;
use std::path::Path;

use fclient::ports::{Account, TxRecord};
use fclient::rpc::{account_json, parse_account};
use serde_json::{json, Value};
use solana_address::Address;

use crate::history::{Gap, History, LedgerMark};
use crate::world::Key;

/// Fixture file format tag.
pub const FIXTURE_FORMAT: &str = "frontier-verify-fixture-v1";

/// What the verifier is told to expect (never read from the chain).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub program: Address,
    pub season_id: u64,
    /// The pinned drand public key (compressed G2): quicknet's in
    /// production, the `test-beacon` key (I-53) for local runs.
    pub quicknet_pk: [u8; 96],
    /// `frontier_abi::presets::RULESET_HASH` of the release expected.
    pub ruleset_hash: [u8; 32],
    /// sha256 of the deployed `.so` expected (V2), if pinned.
    pub program_hash: Option<[u8; 32]>,
}

impl Config {
    pub fn to_json(&self) -> Value {
        json!({
            "program": self.program.to_string(),
            "season_id": self.season_id,
            "quicknet_pk": hex::encode(self.quicknet_pk),
            "ruleset_hash": hex::encode(self.ruleset_hash),
            "program_hash": self.program_hash.map(hex::encode),
        })
    }
    pub fn from_json(v: &Value) -> Result<Config, String> {
        let s = |k: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .ok_or(format!("config.{k}"))
        };
        Ok(Config {
            program: s("program")?.parse().map_err(|_| "config.program")?,
            season_id: v
                .get("season_id")
                .and_then(|x| x.as_u64())
                .ok_or("config.season_id")?,
            quicknet_pk: hex_arr(s("quicknet_pk")?)?,
            ruleset_hash: hex_arr(s("ruleset_hash")?)?,
            program_hash: match v.get("program_hash").and_then(|x| x.as_str()) {
                Some(h) => Some(hex_arr(h)?),
                None => None,
            },
        })
    }
}

pub fn hex_arr<const N: usize>(s: &str) -> Result<[u8; N], String> {
    hex::decode(s)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| format!("want {N} bytes"))
}

/// Everything one verification reads.
#[derive(Clone, Debug)]
pub struct Input {
    pub cfg: Config,
    pub txs: Vec<TxRecord>,
    pub finals: BTreeMap<Key, Option<Account>>,
    pub final_slot: u64,
    /// Observed `.so` hashes per slot range (`(from_slot, sha256)`), from
    /// the ProgramData account or the recording.
    pub program_hashes: Vec<(u64, [u8; 32])>,
    /// Free-form provenance of a fixture (report only).
    pub provenance: String,
    /// Honest-but-adverse scenarios the fixture claims to contain (checked
    /// by the fixture tests, not by the verifier).
    pub scenarios: Vec<String>,
    /// Where `txs` came from and whether that shows them to be the whole
    /// history ([`crate::history`]).
    pub history: History,
    /// The resident program's transactions in the same ledger order, for
    /// V28's holder judgements (⑳, [`crate::resident_feed`]); `None`: the
    /// holder of every ResidentAct is UNVERIFIABLE.
    pub resident_feed: Option<crate::resident_feed::ResidentFeed>,
    /// The pinned program's `.so` bytes, for VX's re-execution of the
    /// playable lane's expedition wrapper and Free City conquest
    /// (`--program-so`; never part of a fixture file: its sha256 must equal
    /// `cfg.program_hash`). `None`: those transactions are UNVERIFIABLE.
    pub program_so: Option<std::sync::Arc<Vec<u8>>>,
    /// States the archive DECLARES rather than shows: a recorder's
    /// `set_account` patches, each in force from before transaction `at`
    /// (an index into `txs`). VX (as a re-execution's starting state), VWL
    /// (as the state before an instruction it re-judges, verifier-coverage),
    /// V7 and V11 (`checks::Before`, verifier-v11-patches /
    /// verifier-v7-patches) and every check that reads
    /// `World::state_before` / `lamports_before` / `state_after`
    /// (verifier-v7-patches) take the later of the last archived post-state
    /// and the declared patch in force; a judgement that read one is never
    /// better than `MissingData`, and the season never better than
    /// UNVERIFIABLE (V0E). The conquest chain walk ([`crate::conquest`])
    /// also continues its event chains from them; VW1 (experimental) still
    /// walks archived post-states only. A real chain archive has none.
    pub declared: Vec<Declared>,
    /// What the chain shows about each transaction beyond its bytes and
    /// logs: `getTransaction`'s `meta.preBalances` / `meta.postBalances`
    /// (which public RPC serves) and the ProgramData's upgrade authority.
    /// With the pinned `.so`, an archive WITHOUT post-states is re-executed
    /// from the Season's creation (`crate::genesis`, VG) instead of being
    /// UNVERIFIABLE for want of them.
    pub chain: ChainWitness,
}

/// Each transaction's lamports before and after it, per message key
/// (`meta.preBalances` / `meta.postBalances`, in message key order).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    pub pre: Vec<u64>,
    pub post: Vec<u64>,
}

/// See [`Input::chain`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChainWitness {
    /// By transaction signature (base58): a reordered or re-signed
    /// transaction keeps or loses its own.
    pub balances: BTreeMap<String, Balances>,
    /// The program's upgrade authority as its ProgramData shows it
    /// (AnnounceSeason reads it). `None`: not read.
    pub upgrade_authority: Option<Address>,
    /// VS: the primary's extra reads and one or more witness RPCs' answers
    /// for the same season (`--witness`, [`crate::witness`]). `None`: no
    /// second source was asked.
    pub cross: Option<crate::witness::CrossCheck>,
    /// The cluster's Rent sysvar the season ran under, for VX's and VG's
    /// re-execution (rent-live-rest; [`crate::rent::rent_of`]): read over
    /// RPC with the final states, recorded with a fixture or a finals file,
    /// or declared by the operator (`--lamports-per-byte`). `None`: no
    /// source stated it — the re-execution then ASSUMES the local node's
    /// 5,080 and the report says so (never a silent constant).
    pub rent: Option<RentRead>,
    /// verifier-v0v1: the address lookup table accounts every v0
    /// transaction's lookups name, as read at the pinned slot (with the
    /// final states: `--rpc`, a finals file's `lookup_tables`, or a
    /// fixture's `chain.lookup_tables`). VT ([`crate::lookup`]) checks each
    /// looked-up address the archive records (`meta.loadedAddresses`)
    /// against them. `None`: none read (VT: UNVERIFIABLE for every lookup).
    pub lookup_tables: Option<LookupTables>,
    /// verifier-alt-archive (F2): lookup table snapshots — findex's, taken
    /// the first time the archive took a transaction using each table (the
    /// record frame's `tables`), and the verifier's own read of a closed
    /// table's create / extend transactions (`--rpc`). VT consults them
    /// only where the pinned read settles nothing ([`crate::lookup`]); VS
    /// has every witness confirm them. Empty: none.
    pub lookup_snapshots: Vec<fclient::alt::Snapshot>,
}

/// See [`ChainWitness::lookup_tables`]. A lookup table is append-only and
/// its address (a PDA of its authority and a recent slot) cannot be created
/// again once closed, so a state read at any later slot shows, at every
/// index it holds, the address that index held when the transaction ran.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LookupTables {
    /// The slot they were read at (`None`: not said).
    pub slot: Option<u64>,
    /// Each table's account (`None`: absent at that slot — closed).
    pub accounts: BTreeMap<Key, Option<Account>>,
}

impl LookupTables {
    pub fn to_json(&self) -> Value {
        json!({
            "slot": self.slot,
            "accounts": self.accounts.iter().map(|(k, a)| json!([Address::new_from_array(*k).to_string(), a.as_ref().map(account_json)])).collect::<Vec<_>>(),
        })
    }
    /// Strict: present but unreadable is an error.
    pub fn from_json(v: &Value) -> Result<LookupTables, String> {
        let slot = match v.get("slot") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_u64().ok_or("lookup_tables.slot")?),
        };
        let accounts = finals_from_json(v.get("accounts").ok_or("lookup_tables.accounts")?)
            .map_err(|e| format!("lookup_tables.accounts: {e}"))?;
        Ok(LookupTables { slot, accounts })
    }
}

/// See [`ChainWitness::rent`]: the Rent sysvar's 17 bytes as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RentRead {
    /// `lamports_per_byte_year u64 ‖ exemption_threshold f64 ‖ burn_percent u8`.
    pub data: [u8; fclient::rent::RENT_LEN],
    /// The slot it was read at (`None`: declared, or not said).
    pub slot: Option<u64>,
    /// Stated by the operator, not read from a chain.
    pub declared: bool,
}

impl RentRead {
    /// Rent stated as a whole rate per byte (threshold 1.0, the local
    /// node's burn share): the operator's `--lamports-per-byte`.
    pub fn declared(lamports_per_byte: u64) -> RentRead {
        let mut r = crate::rent::assumed_rent();
        r.lamports_per_byte_year = lamports_per_byte;
        RentRead {
            data: r.encode(),
            slot: None,
            declared: true,
        }
    }
    /// The sysvar's own bytes as an RPC served them at `slot`.
    pub fn from_chain(data: &[u8], slot: u64) -> Result<RentRead, String> {
        fclient::rent::RentSysvar::decode(data)
            .ok_or("the Rent sysvar is not 17 well-formed bytes")?;
        Ok(RentRead {
            data: data.try_into().map_err(|_| "the Rent sysvar length")?,
            slot: Some(slot),
            declared: false,
        })
    }
    /// The decoded sysvar (`None`: malformed, never used).
    pub fn sysvar(&self) -> Option<fclient::rent::RentSysvar> {
        fclient::rent::RentSysvar::decode(&self.data)
    }
    /// Lamports per byte it charges (`None`: no whole rate).
    pub fn lamports_per_byte(&self) -> Option<u64> {
        crate::rent::rent_per_byte(&self.sysvar()?)
    }
    pub fn to_json(&self) -> Value {
        json!({
            "data": hex::encode(self.data),
            "slot": self.slot,
            "source": if self.declared { "declared" } else { "chain" },
            "lamports_per_byte": self.lamports_per_byte(),
        })
    }
    /// Strict: present but unreadable is an error, never silently absent.
    pub fn from_json(v: &Value) -> Result<RentRead, String> {
        let data: [u8; fclient::rent::RENT_LEN] =
            hex_arr(v.get("data").and_then(|x| x.as_str()).ok_or("rent.data")?)?;
        fclient::rent::RentSysvar::decode(&data).ok_or("rent.data: not a Rent sysvar")?;
        let declared = match v.get("source").and_then(|x| x.as_str()) {
            Some("chain") => false,
            Some("declared") => true,
            _ => return Err("rent.source: chain or declared".into()),
        };
        let slot = match v.get("slot") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_u64().ok_or("rent.slot")?),
        };
        let r = RentRead {
            data,
            slot,
            declared,
        };
        // A stated rate that disagrees with the bytes is refused.
        if let Some(n) = v.get("lamports_per_byte").filter(|x| !x.is_null()) {
            if n.as_u64() != r.lamports_per_byte() {
                return Err("rent.lamports_per_byte disagrees with rent.data".into());
            }
        }
        Ok(r)
    }
}

impl ChainWitness {
    pub fn is_empty(&self) -> bool {
        self.balances.is_empty()
            && self.upgrade_authority.is_none()
            && self.cross.is_none()
            && self.rent.is_none()
            && self.lookup_tables.is_none()
            && self.lookup_snapshots.is_empty()
    }
    /// The balances of the transaction `t`, if archived.
    pub fn of(&self, t: &TxRecord) -> Option<&Balances> {
        self.balances.get(&t.signature.to_string())
    }
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "upgrade_authority": self.upgrade_authority.map(|a| a.to_string()),
            "balances": self.balances.iter().map(|(s, b)| json!([s, b.pre, b.post])).collect::<Vec<_>>(),
        });
        if let Some(c) = &self.cross {
            v["cross"] = c.to_json();
        }
        if let Some(r) = &self.rent {
            v["rent"] = r.to_json();
        }
        if let Some(t) = &self.lookup_tables {
            v["lookup_tables"] = t.to_json();
        }
        if !self.lookup_snapshots.is_empty() {
            v["lookup_snapshots"] = snapshots_json(&self.lookup_snapshots);
        }
        v
    }
    pub fn from_json(v: &Value) -> Result<ChainWitness, String> {
        let nums = |x: Option<&Value>, what: &str| -> Result<Vec<u64>, String> {
            x.and_then(|a| a.as_array())
                .ok_or(format!("chain.balances {what}"))?
                .iter()
                .map(|n| n.as_u64().ok_or(format!("chain.balances {what}")))
                .collect()
        };
        let mut balances = BTreeMap::new();
        for e in v
            .get("balances")
            .and_then(|x| x.as_array())
            .map(|a| a.as_slice())
            .unwrap_or_default()
        {
            let sig = e
                .get(0)
                .and_then(|x| x.as_str())
                .ok_or("chain.balances signature")?;
            balances.insert(
                sig.to_string(),
                Balances {
                    pre: nums(e.get(1), "pre")?,
                    post: nums(e.get(2), "post")?,
                },
            );
        }
        let upgrade_authority = match v.get("upgrade_authority") {
            None | Some(Value::Null) => None,
            Some(x) => Some(
                x.as_str()
                    .and_then(|s| s.parse().ok())
                    .ok_or("chain.upgrade_authority")?,
            ),
        };
        Ok(ChainWitness {
            balances,
            upgrade_authority,
            cross: match v.get("cross") {
                None | Some(Value::Null) => None,
                Some(c) => Some(crate::witness::CrossCheck::from_json(c)?),
            },
            rent: match v.get("rent") {
                None | Some(Value::Null) => None,
                Some(r) => Some(RentRead::from_json(r)?),
            },
            lookup_tables: match v.get("lookup_tables") {
                None | Some(Value::Null) => None,
                Some(t) => Some(LookupTables::from_json(t)?),
            },
            lookup_snapshots: snapshots_from_json(v.get("lookup_snapshots"))?,
        })
    }
}

/// The JSON list of [`ChainWitness::lookup_snapshots`].
pub fn snapshots_json(s: &[fclient::alt::Snapshot]) -> Value {
    Value::Array(s.iter().map(|x| x.to_json()).collect())
}

/// Strict: present but unreadable is an error; absent or null is none.
pub fn snapshots_from_json(v: Option<&Value>) -> Result<Vec<fclient::alt::Snapshot>, String> {
    match v {
        None | Some(Value::Null) => Ok(vec![]),
        Some(a) => a
            .as_array()
            .ok_or("lookup_snapshots: not a list")?
            .iter()
            .map(fclient::alt::Snapshot::from_json)
            .collect(),
    }
}

/// The lookup table snapshots a findex archive holds (verifier-alt-archive;
/// [`findex::archive::Archive::lookup_snapshots`]).
pub fn archive_lookup_snapshots(dir: &Path) -> Result<Vec<fclient::alt::Snapshot>, String> {
    let a = findex::archive::Archive::open(dir, findex::archive::SEGMENT_BYTES)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(a.lookup_snapshots()
        .map_err(|e| format!("{}: lookup snapshots: {e}", dir.display()))?
        .into_iter()
        .map(|(_, s)| s)
        .collect())
}

/// One declared state (see [`Input::declared`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declared {
    /// In force from before `txs[at]`.
    pub at: usize,
    pub key: Key,
    pub account: Option<Account>,
    /// What the patch is (report text).
    pub what: String,
}

impl Input {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "format": FIXTURE_FORMAT,
            "provenance": self.provenance,
            "scenarios": self.scenarios,
            "config": self.cfg.to_json(),
            "final_slot": self.final_slot,
            "program_hashes": self.program_hashes.iter().map(|(s, h)| json!([s, hex::encode(h)])).collect::<Vec<_>>(),
            "txs": self.txs.iter().map(findex::archive::record_to_json).collect::<Vec<_>>(),
            "finals": self.finals.iter().map(|(k, a)| json!([Address::new_from_array(*k).to_string(), a.as_ref().map(account_json)])).collect::<Vec<_>>(),
        });
        // Saved from RPC or an archive, a fixture keeps where its
        // transactions came from (it does not become `as_given`).
        if let Some(h) = self.history.to_json() {
            v["history"] = h;
        }
        if let Some(f) = &self.resident_feed {
            v["resident_feed"] = f.to_json();
        }
        if !self.chain.is_empty() {
            v["chain"] = self.chain.to_json();
        }
        if !self.declared.is_empty() {
            v["declared"] = Value::Array(
                self.declared
                    .iter()
                    .map(|d| {
                        json!([
                            d.at,
                            Address::new_from_array(d.key).to_string(),
                            d.account.as_ref().map(account_json),
                            d.what
                        ])
                    })
                    .collect(),
            );
        }
        v
    }

    pub fn from_json(v: &Value) -> Result<Input, String> {
        if v.get("format").and_then(|x| x.as_str()) != Some(FIXTURE_FORMAT) {
            return Err(format!("not a {FIXTURE_FORMAT} file"));
        }
        let cfg = Config::from_json(v.get("config").ok_or("config")?)?;
        let txs = v
            .get("txs")
            .and_then(|x| x.as_array())
            .ok_or("txs")?
            .iter()
            .map(findex::archive::record_from_json)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Input {
            cfg,
            txs,
            finals: finals_from_json(v.get("finals").ok_or("finals")?)?,
            final_slot: v.get("final_slot").and_then(|x| x.as_u64()).unwrap_or(0),
            program_hashes: v
                .get("program_hashes")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| {
                            Some((p.get(0)?.as_u64()?, hex_arr(p.get(1)?.as_str()?).ok()?))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            provenance: v
                .get("provenance")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .into(),
            scenarios: v
                .get("scenarios")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            history: History::from_json(v.get("history")),
            // Present but unreadable is an error, never silently absent.
            resident_feed: v
                .get("resident_feed")
                .map(crate::resident_feed::ResidentFeed::from_json)
                .transpose()?,
            program_so: None,
            declared: match v.get("declared") {
                None => vec![],
                Some(d) => declared_from_json(d)?,
            },
            chain: match v.get("chain") {
                None => ChainWitness::default(),
                Some(c) => ChainWitness::from_json(c)?,
            },
        })
    }

    /// Reads a fixture; a `.gz` path is gzip-compressed JSON (integ-W4:
    /// the recorded march season of the program, DECISIONS J2's `flate2`).
    pub fn load(path: &Path) -> Result<Input, String> {
        let raw = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let bytes = if path.extension().is_some_and(|x| x == "gz") {
            use std::io::Read;
            let mut out = vec![];
            flate2::read::GzDecoder::new(&raw[..])
                .read_to_end(&mut out)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            out
        } else {
            raw
        };
        let v: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        Input::from_json(&v)
    }

    /// Writes the fixture (one transaction per line, so diffs stay small).
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let v = self.to_json();
        let mut out = String::from("{\n");
        let obj = v.as_object().ok_or("object")?;
        let n = obj.len();
        for (i, (k, x)) in obj.iter().enumerate() {
            out.push_str(&format!("{}: ", Value::String(k.clone())));
            match x {
                Value::Array(a) if k == "txs" || k == "finals" => {
                    out.push_str("[\n");
                    for (j, e) in a.iter().enumerate() {
                        out.push_str(&e.to_string());
                        out.push_str(if j + 1 < a.len() { ",\n" } else { "\n" });
                    }
                    out.push(']');
                }
                _ => out.push_str(&x.to_string()),
            }
            out.push_str(if i + 1 < n { ",\n" } else { "\n" });
        }
        out.push_str("}\n");
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        if path.extension().is_some_and(|x| x == "gz") {
            use std::io::Write;
            let f = std::fs::File::create(path).map_err(|e| e.to_string())?;
            let mut z = flate2::write::GzEncoder::new(f, flate2::Compression::best());
            z.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
            z.finish().map_err(|e| e.to_string())?;
            return Ok(());
        }
        std::fs::write(path, out).map_err(|e| e.to_string())
    }
}

fn declared_from_json(v: &Value) -> Result<Vec<Declared>, String> {
    let mut out = vec![];
    for p in v.as_array().ok_or("declared")? {
        let at = p.get(0).and_then(|x| x.as_u64()).ok_or("declared at")? as usize;
        let k: Address = p
            .get(1)
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or("declared key")?;
        let account = parse_account(p.get(2).unwrap_or(&Value::Null)).map_err(|e| e.to_string())?;
        let what = p.get(3).and_then(|x| x.as_str()).unwrap_or("").to_string();
        out.push(Declared {
            at,
            key: k.to_bytes(),
            account,
            what,
        });
    }
    Ok(out)
}

pub fn finals_from_json(v: &Value) -> Result<BTreeMap<Key, Option<Account>>, String> {
    let mut m = BTreeMap::new();
    for p in v.as_array().ok_or("finals")? {
        let k: Address = p
            .get(0)
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or("finals key")?;
        let a = parse_account(p.get(1).unwrap_or(&Value::Null)).map_err(|e| e.to_string())?;
        m.insert(k.to_bytes(), a);
    }
    Ok(m)
}

/// Every key a successful transaction of the archive wrote (the accounts
/// whose final state the verifier reads).
pub fn written_keys(txs: &[TxRecord]) -> Vec<Address> {
    let mut v: std::collections::BTreeSet<[u8; 32]> = Default::default();
    for t in txs.iter().filter(|t| t.err.is_none()) {
        if let Ok(m) = crate::vmsg::Msg::of(t) {
            for (i, k) in m.keys.iter().enumerate() {
                if m.is_writable_index(i) {
                    v.insert(k.to_bytes());
                }
            }
        }
        for (k, _) in &t.post {
            v.insert(k.to_bytes());
        }
    }
    v.into_iter().map(Address::new_from_array).collect()
}

/// Reads a findex archive directory (`manifest.json` + segments) and where
/// its records came from (the cursor its manifest holds, see
/// [`History::of_archive`]).
///
/// Restores original ledger sequence numbers when archive parts are structurally
/// consistent. This does not establish freshness: a stale part after same-run
/// rollback can pass those checks. Archive history therefore remains Unknown
/// until a shared rollback/freshness proof is implemented.
pub fn read_archive(dir: &Path) -> Result<(Vec<TxRecord>, History), String> {
    let a = findex::archive::Archive::open(dir, findex::archive::SEGMENT_BYTES)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    a.verify()?;
    let shown = dir.display().to_string();
    if a.cursor().get("feed_after").is_some() || a.cursor().get("feed_refused").is_some() {
        let part =
            findex::ledger::Part::of_archive(shown.clone(), &a).map_err(|e| e.to_string())?;
        let j = findex::ledger::join(std::slice::from_ref(&part));
        let mut txs: Vec<TxRecord> = part.records.into_iter().map(|(r, _)| r).collect();
        if txs.is_empty() {
            let h = History::unknown(format!(
                "archive {shown}: an empty local feed archive, not proof of an empty season"
            ));
            return Ok((txs, h));
        }
        if !j.whole() {
            let h = History::unknown(format!(
                "archive {shown}: not the ledger's whole feed: {}",
                j.problems.join("; ")
            ));
            return Ok((txs, h));
        }
        for (t, e) in txs.iter_mut().zip(&j.entries) {
            t.seq = e.feed_seq;
        }
        let id = j.ledger.unwrap_or_default();
        // The ledger's numbers are restored, but an archive alone shows none
        // of: that the node still holds it (a later rewind), that the
        // ledger's records up to it are the node's (no ledger digest), that
        // it is at the final states' point. Each is named; it is never whole.
        let mark = archive_mark(&id, a.cursor());
        let h = History::ledger_feed(format!("ledger {id}{ARCHIVE_ONLY}"))
            .with_gaps(&[
                Gap::ArchiveOnly,
                Gap::PrefixIdentityUnverified,
                Gap::PointInTimeUnverified,
            ])
            .with_mark(mark);
        return Ok((txs, h));
    }
    let txs = a.read_after(0).map_err(|e| e.to_string())?;
    let h = History::of_archive(a.cursor(), !txs.is_empty(), &shown);
    Ok((txs, h))
}

/// The detail suffix of an archive's `ledger_feed` not checked against the
/// node (see [`confirm_archive`]).
pub const ARCHIVE_ONLY: &str =
    " (archive only: not checked against the node; a later rewind of its ledger is not seen)";

/// The ledger point an archive was scanned through (`feed_scanned`, the
/// node's scan: every ledger entry up to it examined), if it was.
fn archive_mark(id: &str, cursor: &Value) -> Option<LedgerMark> {
    let len = cursor.get("feed_scanned").and_then(|x| x.as_u64())?;
    (!id.is_empty()).then(|| LedgerMark {
        run_id: id.to_string(),
        ledger_len: len,
        ledger_bytes: None,
    })
}

/// Observational cross-check against the node: discrepancies are Unknown.
/// Even a matching tail is not an atomic whole-ledger snapshot, so the
/// returned history remains unproven until that freshness contract exists:
/// on a match, `ledger_feed` without `archive_only` but still with
/// `prefix_identity_unverified` (no node-side digest of the ledger's
/// records) and `point_in_time_unverified` until [`seal_point_in_time`]; on
/// a mismatch, `unknown` with `tail_mismatch`.
pub async fn confirm_archive(dir: &Path, url: &str, h: History) -> Result<History, String> {
    let a = findex::archive::Archive::open(dir, findex::archive::SEGMENT_BYTES)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let part = findex::ledger::Part::of_archive(dir.display().to_string(), &a)
        .map_err(|e| e.to_string())?;
    let joined = findex::ledger::join(std::slice::from_ref(&part));
    if !joined.whole() {
        return Ok(History::unknown(format!(
            "archive structure unproven: {}",
            joined.problems.join("; ")
        )));
    }
    let why = findex::ledger::check_node(url, std::slice::from_ref(&part)).await;
    if !why.is_empty() {
        return Ok(History::unknown(format!(
            "archive {}: not confirmed against the node {url}: {}",
            dir.display(),
            why.join("; ")
        ))
        .with_gaps(&[Gap::TailMismatch]));
    }
    let id = joined.ledger.unwrap_or_default();
    let _ = h;
    Ok(History::ledger_feed(format!("ledger {id}"))
        .with_gaps(&[Gap::PrefixIdentityUnverified, Gap::PointInTimeUnverified])
        .with_mark(archive_mark(&id, a.cursor())))
}

/// What a live `ledger_feed` read of the local node (findex `LocalnetFeed`)
/// could not show: `prefix_identity_unverified` unless every read was scanned
/// from a ledger that cannot rewind under its runId (`rewind_safe`), and
/// `point_in_time_unverified` until [`seal_point_in_time`]. The ledger point
/// is noted when the node, read now, is still where the last scan ended.
pub async fn live_assurance(
    url: &str,
    h: History,
    rewind_safe: Option<bool>,
    scanned: Option<u64>,
) -> History {
    let st = findex::ledger::node_status(url).await.ok();
    let mark = st.and_then(|st| {
        let len = st.transactions?;
        let run_id = st.run_id?;
        (scanned == Some(len)).then_some(LedgerMark {
            run_id,
            ledger_len: len,
            ledger_bytes: st.ledger_bytes,
        })
    });
    let mut h = h.with_gaps(&[Gap::PointInTimeUnverified]).with_mark(mark);
    if rewind_safe != Some(true) {
        h.add_gap(Gap::PrefixIdentityUnverified);
    }
    h
}

/// Once the final states are read: the node still at the ledger point the
/// history was read through (the same runId, the same number of ledger
/// entries, the same size when it was noted) shows the two were read at one
/// point, and `point_in_time_unverified` is dropped. Otherwise it stays, and
/// why is added to the detail. Nothing else changes.
pub async fn seal_point_in_time(url: &str, h: &mut History) {
    if !h.gaps.contains(&Gap::PointInTimeUnverified) {
        return;
    }
    let Some(m) = h.mark.clone() else {
        h.detail
            .push_str("; point in time: the history's ledger point is not known");
        return;
    };
    match findex::ledger::node_status(url).await {
        Ok(st)
            if st.run_id.as_deref() == Some(m.run_id.as_str())
                && st.transactions == Some(m.ledger_len)
                && m.ledger_bytes.is_none_or(|b| st.ledger_bytes == Some(b)) =>
        {
            h.remove_gap(Gap::PointInTimeUnverified);
        }
        Ok(st) => h.detail.push_str(&format!(
            "; point in time: read through ledger {} entry {} ({:?} B), the node is at ledger {:?} entry {:?} ({:?} B) after the final states",
            m.run_id, m.ledger_len, m.ledger_bytes, st.run_id, st.transactions, st.ledger_bytes
        )),
        Err(e) => h
            .detail
            .push_str(&format!("; point in time: the node could not be read ({e})")),
    }
}

/// The verifier's JSON-RPC client of `url` (B5): one [`Pacer`] per endpoint
/// for the whole run, so every read of one public RPC is spaced (a 429
/// backs off its method, a 503 every method: rpc-pacer-per-method), and a
/// 429/503 is retried after the server's `Retry-After`
/// instead of ending the run (measured 2026-11-21: the public devnet RPC
/// allows about 10 calls of one method per 10 s, so the 11th
/// `getTransaction` of a season stopped `frontier-verify` with `Http(429)`).
/// An `https://` URL is paced [`DEFAULT_PUBLIC_GAP_MS`] apart; a loopback
/// URL is unpaced unless [`set_rpc_min_gap_ms`] was given (a loopback
/// proxy or tunnel to a public RPC), and then it also retries.
///
/// [`Pacer`]: fclient::rpc::Pacer
pub fn rpc_client(url: &str) -> fclient::rpc::RpcClient {
    let c = fclient::rpc::RpcClient::new(url);
    match pacer_of(url) {
        Some(p) => {
            let forced = MIN_GAP_MS.load(std::sync::atomic::Ordering::Relaxed) != u64::MAX;
            let c = c.with_pacer(p);
            if forced {
                c.with_retries(fclient::rpc::PUBLIC_RETRIES)
            } else {
                c
            }
        }
        None => c,
    }
}

/// [`rpc_client`]'s spacing of a public (`https://`) endpoint.
pub const DEFAULT_PUBLIC_GAP_MS: u64 = 250;

static MIN_GAP_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);
type Pacers = std::sync::Mutex<BTreeMap<String, std::sync::Arc<fclient::rpc::Pacer>>>;
static PACERS: std::sync::OnceLock<Pacers> = std::sync::OnceLock::new();

/// `--rpc-min-gap-ms`: the spacing of EVERY endpoint, loopback included
/// (0: none at all). Call before the first read.
pub fn set_rpc_min_gap_ms(ms: u64) {
    MIN_GAP_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

fn pacer_of(url: &str) -> Option<std::sync::Arc<fclient::rpc::Pacer>> {
    let forced = MIN_GAP_MS.load(std::sync::atomic::Ordering::Relaxed);
    let gap = match forced {
        u64::MAX if url.starts_with("https://") => DEFAULT_PUBLIC_GAP_MS,
        u64::MAX => 0,
        g => g,
    };
    if gap == 0 {
        return None;
    }
    let mut m = PACERS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    Some(
        m.entry(url.to_string())
            .or_insert_with(|| {
                fclient::rpc::Pacer::new(
                    std::time::Duration::from_millis(gap),
                    std::time::Duration::from_secs(30),
                )
            })
            .clone(),
    )
}

/// Requests made (each retry counted) and of them answered 429/503, per
/// paced endpoint, so far in this process (the run's request budget).
pub fn rpc_calls() -> Vec<(String, u64, u64)> {
    let Some(m) = PACERS.get() else { return vec![] };
    let m = m.lock().unwrap_or_else(|e| e.into_inner());
    m.iter()
        .map(|(u, p)| {
            (
                fclient::https::redact(u),
                p.calls.load(std::sync::atomic::Ordering::Relaxed),
                p.throttles.load(std::sync::atomic::Ordering::Relaxed),
            )
        })
        .collect()
}

/// The ledger a local node serves (`frontier_status.runId`), if it says.
pub async fn ledger_id(url: &str) -> Option<String> {
    let v = rpc_client(url)
        .call("frontier_status", json!([]))
        .await
        .ok()?;
    v.get("runId").and_then(|x| x.as_str()).map(String::from)
}

/// The final states of `keys` and the slot they were read at, over RPC.
pub async fn fetch_finals(
    url: &str,
    keys: &[Address],
) -> Result<(BTreeMap<Key, Option<Account>>, u64), String> {
    use fclient::ports::ChainPort;
    let mut port = fclient::rpc::RpcPort::new(url, Address::default());
    port.rpc = rpc_client(url);
    let slot = port.clock().await.map_err(|e| e.to_string())?.slot;
    let mut m = BTreeMap::new();
    for chunk in keys.chunks(100) {
        let got = port
            .accounts(chunk, slot)
            .await
            .map_err(|e| e.to_string())?;
        for (k, a) in chunk.iter().zip(got) {
            m.insert(k.to_bytes(), a);
        }
    }
    Ok((m, slot))
}

/// Every account the program owns now, of this season (the season id at
/// the common header offset 8), over RPC (`getProgramAccounts`; integ-W4
/// review, W4-D major: the finals were read only for the keys the
/// archive's transactions wrote, so an archive with transactions filtered
/// out hid the accounts they explain).
pub async fn program_accounts(
    url: &str,
    program: &Address,
    season_id: u64,
) -> Result<Vec<Address>, String> {
    use base64::Engine as _;
    let c = rpc_client(url);
    // The season id at offset 8, filtered by the node and sliced to those 8
    // bytes (B5: unfiltered, a public RPC sent every account's whole data,
    // every season's, to be filtered here). Checked here again below.
    let id = base64::engine::general_purpose::STANDARD.encode(season_id.to_le_bytes());
    let v = c
        .call(
            "getProgramAccounts",
            serde_json::json!([program.to_string(), {"encoding": "base64", "commitment": "confirmed",
                "filters": [{"memcmp": {"offset": 8, "bytes": id, "encoding": "base64"}}],
                "dataSlice": {"offset": 8, "length": 8}}]),
        )
        .await
        .map_err(|e| e.to_string())?;
    let arr = v
        .as_array()
        .or_else(|| v.get("value").and_then(|x| x.as_array()))
        .ok_or("getProgramAccounts: not an array")?;
    let mut out = vec![];
    for x in arr {
        let k: Address = x
            .get("pubkey")
            .and_then(|p| p.as_str())
            .and_then(|p| p.parse().ok())
            .ok_or("getProgramAccounts: pubkey")?;
        let data = x
            .pointer("/account/data/0")
            .and_then(|d| d.as_str())
            .map(|d| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(d)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        // The 8-byte slice asked for; a node that ignored `dataSlice` (and
        // perhaps the filter) sent the whole data: the id is at 8..16 there
        // (verify-pr123: else such a node's accounts all read as missing).
        let id_bytes = if data.len() == 8 {
            data.get(..8)
        } else {
            data.get(8..16)
        };
        if id_bytes.map(crate::world::le) == Some(season_id) {
            out.push(k);
        }
    }
    Ok(out)
}

/// The deployed `.so`'s sha256 and the ProgramData's last deploy slot, over
/// RPC (upgradeable loader: the program account names its ProgramData;
/// ProgramData = 45-B header ‖ the ELF padded to `max_len`, the ELF's own
/// length from its header). Integ-W4 review, W4-D major: V2's `.so` hash
/// had no source in RPC and archive modes.
pub async fn program_hash(url: &str, program: &Address) -> Result<(u64, [u8; 32]), String> {
    let mut port = fclient::rpc::RpcPort::new(url, *program);
    port.rpc = rpc_client(url);
    let got = port
        .rpc
        .get_multiple_accounts(&[*program], 0)
        .await
        .map_err(|e| e.to_string())?;
    let pa = got
        .into_iter()
        .next()
        .flatten()
        .ok_or("the program account is absent")?;
    let pd_key: [u8; 32] = pa
        .data
        .get(4..36)
        .and_then(|x| x.try_into().ok())
        .ok_or("the program account is not an upgradeable Program")?;
    let got = port
        .rpc
        .get_multiple_accounts(&[Address::new_from_array(pd_key)], 0)
        .await
        .map_err(|e| e.to_string())?;
    let pd = got
        .into_iter()
        .next()
        .flatten()
        .ok_or("the ProgramData account is absent")?;
    let slot = pd
        .data
        .get(4..12)
        .map(crate::world::le)
        .ok_or("ProgramData header")?;
    let elf = pd.data.get(45..).ok_or("ProgramData: no ELF")?;
    let n = elf_len(elf).ok_or("ProgramData: not an ELF64")?;
    Ok((slot, permutation_rules::hash::sha256(&[&elf[..n]])))
}

/// VG's chain witness over RPC (`--balances`): every archived transaction's
/// `meta.preBalances` / `postBalances` (finalized `getTransaction`; a public
/// RPC serves them) and the program's upgrade authority from its
/// ProgramData. A transaction whose balances are not served is left out
/// (VG then says UNVERIFIABLE for it). One extra `getTransaction` per
/// transaction: on devnet this is a read the owner approves per run (B5).
pub async fn fetch_chain(
    url: &str,
    program: &Address,
    txs: &[TxRecord],
) -> Result<ChainWitness, String> {
    let rpc = rpc_client(url);
    let mut balances = BTreeMap::new();
    for t in txs {
        if let Some((pre, post)) = rpc
            .get_transaction_balances(&t.signature, "finalized")
            .await
            .map_err(|e| e.to_string())?
        {
            balances.insert(t.signature.to_string(), Balances { pre, post });
        }
    }
    Ok(ChainWitness {
        balances,
        upgrade_authority: upgrade_authority(url, program).await?,
        cross: None,
        rent: None,
        lookup_tables: None,
        lookup_snapshots: vec![],
    })
}

/// verifier-v0v1: every lookup table a v0 transaction of `txs` names (the
/// accounts [`fetch_lookup_tables`] reads with the final states).
pub fn lookup_table_keys(txs: &[TxRecord]) -> Vec<Address> {
    let mut v: std::collections::BTreeSet<Address> = Default::default();
    for t in txs {
        if let Ok(d) = fclient::vtx::decode(&t.tx) {
            v.extend(d.lookups.iter().map(|l| l.account_key));
        }
    }
    v.into_iter().collect()
}

/// The lookup tables `keys` at `slot` or later, over RPC (the final
/// states' read; VT checks the archive's `loadedAddresses` against them).
pub async fn fetch_lookup_tables(
    url: &str,
    keys: &[Address],
    slot: u64,
) -> Result<LookupTables, String> {
    use fclient::ports::ChainPort;
    let mut port = fclient::rpc::RpcPort::new(url, Address::default());
    port.rpc = rpc_client(url);
    let mut accounts = BTreeMap::new();
    for chunk in keys.chunks(100) {
        let got = port
            .accounts(chunk, slot)
            .await
            .map_err(|e| e.to_string())?;
        for (k, a) in chunk.iter().zip(got) {
            accounts.insert(k.to_bytes(), a);
        }
    }
    Ok(LookupTables {
        slot: Some(slot),
        accounts,
    })
}

/// verifier-alt-archive (F2): for every table of `tables` that is closed
/// at its read (absent, or a System account with only lamports), its own
/// create / extend transactions over RPC, as a snapshot of the verifier's
/// ([`fclient::alt::read_history`]; VT replays it). A table whose history
/// cannot be read is said on stderr and left without (UNVERIFIABLE).
pub async fn fetch_closed_table_histories(
    url: &str,
    tables: &LookupTables,
) -> Vec<fclient::alt::Snapshot> {
    let rpc = rpc_client(url);
    let mut out = vec![];
    for (k, a) in &tables.accounts {
        if fclient::alt::classify(a.as_ref()) != fclient::alt::Read::Closed {
            continue;
        }
        let t = Address::new_from_array(*k);
        match fclient::alt::read_history(&rpc, &t).await {
            Ok(None) => eprintln!(
                "frontier-verify: lookup table {t}'s history is longer than {} transactions: not read",
                fclient::alt::HISTORY_MAX
            ),
            Ok(Some(h)) => out.push(fclient::alt::Snapshot {
                table: t,
                used_by: None,
                read_slot: tables.slot,
                account: None,
                history: Some(h),
                source: "verifier".into(),
            }),
            Err(e) => eprintln!("frontier-verify: lookup table {t}'s history: {e}"),
        }
    }
    out
}

/// The cluster's Rent sysvar at `slot` or later, over RPC (one
/// `getMultipleAccounts`; rent-live-rest): what VX / VG re-execute under.
/// An absent or malformed sysvar is an error (the caller says so; the
/// re-execution then assumes 5,080 and the report labels it).
pub async fn fetch_rent(url: &str, slot: u64) -> Result<RentRead, String> {
    use fclient::ports::ChainPort;
    let mut port = fclient::rpc::RpcPort::new(url, Address::default());
    port.rpc = rpc_client(url);
    let key = fclient::rent::rent_sysvar();
    let got = port
        .accounts(&[key], slot)
        .await
        .map_err(|e| e.to_string())?;
    let a = got
        .into_iter()
        .next()
        .flatten()
        .ok_or("the Rent sysvar is absent")?;
    if a.owner != fclient::rent::sysvar_owner() {
        return Err("the Rent sysvar is not owned by the sysvar program".into());
    }
    RentRead::from_chain(&a.data, slot)
}

/// The upgrade authority the program's ProgramData names (`None`: none, or
/// not an upgradeable program).
pub async fn upgrade_authority(url: &str, program: &Address) -> Result<Option<Address>, String> {
    let loader: Address = "BPFLoaderUpgradeab1e11111111111111111111111"
        .parse()
        .map_err(|_| "the LoaderV3 id")?;
    let (pd, _) = Address::find_program_address(&[program.as_ref()], &loader);
    let mut port = fclient::rpc::RpcPort::new(url, *program);
    port.rpc = rpc_client(url);
    let got = port
        .rpc
        .get_multiple_accounts(&[pd], 0)
        .await
        .map_err(|e| e.to_string())?;
    Ok(got
        .into_iter()
        .next()
        .flatten()
        .and_then(|a| programdata_authority(&a.data)))
}

/// UpgradeableLoaderState::ProgramData `{ slot: u64, upgrade_authority:
/// Option<Pubkey> }` after its u32 tag 3: the authority, if set.
pub fn programdata_authority(d: &[u8]) -> Option<Address> {
    if d.get(..4)? != 3u32.to_le_bytes() || *d.get(12)? != 1 {
        return None;
    }
    Some(Address::new_from_array(d.get(13..45)?.try_into().ok()?))
}

/// The length of an ELF64 file from its header: the end of its section
/// header table or of its last program segment, whichever is later.
pub fn elf_len(b: &[u8]) -> Option<usize> {
    if b.get(..4)? != b"\x7fELF" || *b.get(4)? != 2 {
        return None;
    }
    let u16_at = |o: usize| Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?) as u64);
    let u64_at = |o: usize| Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?));
    let (phoff, shoff) = (u64_at(0x20)?, u64_at(0x28)?);
    let (phentsize, phnum) = (u16_at(0x36)?, u16_at(0x38)?);
    let (shentsize, shnum) = (u16_at(0x3A)?, u16_at(0x3C)?);
    let mut end = shoff + shentsize * shnum;
    for i in 0..phnum {
        let o = (phoff + i * phentsize) as usize;
        end = end.max(u64_at(o + 8)? + u64_at(o + 0x20)?);
    }
    usize::try_from(end).ok().filter(|&n| n <= b.len())
}

/// Empty pulls with signatures held back that [`fetch_txs`] waits through.
pub const HELD_WAITS: u32 = 60;
pub const HELD_WAIT: std::time::Duration = std::time::Duration::from_millis(400);

/// The program's transactions over RPC: `frontier_feed` on a local node,
/// else `getSignaturesForAddress` + `getTransaction` (findex `RpcPoll`),
/// with where they came from. Over public RPC the [`History`] carries
/// `RpcPoll`'s coverage (never complete, see [`crate::history`]); `origin`
/// and `witness` are its optional G1/G3 checks. A history gap (or an
/// unreadable source) is an error: nothing is verified over it.
pub async fn fetch_txs(
    url: &str,
    program: &Address,
    localnet: bool,
    origin: Option<fclient::ports::Signature>,
    witness: Option<&str>,
) -> Result<(Vec<TxRecord>, History), String> {
    use findex::ingest::Source;
    let mut out = vec![];
    if localnet {
        // The ledger is read before and after the feed: a node that started
        // a new ledger in between numbers its feed afresh.
        let before = findex::ledger::node_status(url).await.ok();
        let mut s =
            findex::ingest::LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, *program))
                .with_program(*program);
        loop {
            let b = s.pull().await.map_err(|e| e.to_string())?;
            if b.is_empty() {
                break;
            }
            out.extend(b);
        }
        let after = findex::ledger::node_status(url).await.ok();
        let id = |s: &Option<findex::ledger::NodeStatus>| s.as_ref().and_then(|s| s.run_id.clone());
        let bytes =
            |s: &Option<findex::ledger::NodeStatus>| s.as_ref().and_then(|s| s.ledger_bytes);
        let shrank = bytes(&before).zip(bytes(&after)).filter(|(b, a)| a < b);
        // Prefix identity of a live read: every read scanned, none from a
        // ledger that could rewind under the same runId (findex
        // `LocalnetFeed::rewind_safe`). The point: where the read ended, if
        // the node's ledger had not moved past the last scan.
        let prefix_ok = s.rewind_safe() == Some(true);
        let mark = after.as_ref().and_then(|st| {
            let len = st.transactions?;
            let run_id = st.run_id.clone()?;
            (s.scanned() == Some(len)).then_some(LedgerMark {
                run_id,
                ledger_len: len,
                ledger_bytes: st.ledger_bytes,
            })
        });
        let history = if out.is_empty() {
            History::unknown(format!(
                "local node feed {url}: empty observation, not proof of an empty season"
            ))
        } else if before.is_none()
            || after.is_none()
            || id(&before).is_none()
            || id(&after).is_none()
        {
            History::unknown(format!(
                "local node feed {url}: ledger status unavailable; nothing confirmed"
            ))
        } else if id(&before) != id(&after) {
            History::unknown(format!(
                "local node feed {url}: the ledger changed while it was read ({:?} to {:?})",
                id(&before),
                id(&after)
            ))
        } else if let Some((b, a)) = shrank {
            History::unknown(format!(
                "local node feed {url}: the ledger shrank while it was read ({b} to {a} bytes): rewound"
            ))
        } else {
            let h = match id(&after) {
                Some(id) => History::ledger_feed(format!("ledger {id}")),
                None => {
                    History::ledger_feed(format!("local node feed {url} (ledger not reported)"))
                }
            };
            let mut h = h.with_gaps(&[Gap::PointInTimeUnverified]).with_mark(mark);
            if !prefix_ok {
                h.add_gap(Gap::PrefixIdentityUnverified);
            }
            h
        };
        return Ok((out, history));
    }
    let mut s = findex::ingest::RpcPoll::new(url, *program);
    s.rpc = rpc_client(url);
    if let Some(o) = origin {
        s = s.with_origin(o);
    }
    if let Some(w) = witness {
        s.witness = Some(rpc_client(w));
    }
    let mut waits = 0;
    loop {
        let b = s.pull().await.map_err(|e| e.to_string())?;
        if b.is_empty() {
            // An empty pull with signatures held back (a witness behind, a
            // transaction not retrievable yet) is not the end of the history:
            // pull again (RpcPoll archives them unchecked after a bound). A
            // tail still held back after `HELD_WAITS` stays in `heldBack`.
            if s.held_back() == 0 || waits >= HELD_WAITS {
                break;
            }
            waits += 1;
            tokio::time::sleep(HELD_WAIT).await;
            continue;
        }
        out.extend(b);
    }
    Ok((out, History::rpc(s.coverage(), format!("rpc {url}"))))
}
