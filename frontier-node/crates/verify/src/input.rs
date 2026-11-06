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
//!
//! **History evidence (V0H, 2026-11-07).** None of the three sources proves
//! that the transactions given are *all* of the season's: a findex archive
//! proves its own integrity, one node's `getSignaturesForAddress` cannot
//! show a gap on its first pull or a range its own history lacks
//! (`findex::ingest`), and a fixture is whatever was recorded. The loaders
//! therefore say what they observed ([`HistoryEvidence`]: the source, the
//! observation, its bounds) and the verifier judges that evidence
//! (`checks::v0_history`): a real-chain source without coverage evidence
//! is `Unverifiable`, never a PASS; a fixture or a local harness feed is
//! judged **as a dataset**, and the report says so. There is deliberately
//! no "complete" variant: an input cannot declare itself whole.

use std::collections::BTreeMap;
use std::path::Path;

use fclient::ports::{Account, TxRecord};
use fclient::rpc::{account_json, parse_account};
use serde_json::{json, Value};
use solana_address::Address;

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

/// Where the season's transactions were observed (V0H). There is no
/// variant for a complete history: a source kind says how the
/// transactions were gathered, not that they are all of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistorySource {
    /// Nothing recorded: a fixture written before the `history` block, or
    /// an input built in code without saying.
    Unstated,
    /// A recorded or synthetic dataset (a fixture, a slice, a builder).
    Dataset { label: String },
    /// A findex archive directory (`manifest.json` + segments).
    Archive { dir: String },
    /// One node's `getSignaturesForAddress` + `getTransaction`
    /// (`findex::ingest::RpcPoll`).
    RpcPoll { url: String },
    /// A local node's own `frontier_feed` (the in-process chain, the
    /// stack's node): the local harness, not a public chain.
    LocalnetFeed { url: String },
}

/// What the loader saw when it read the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HistoryObservation {
    /// Nothing recorded.
    Unstated,
    /// The source was named but not read.
    NotFetched { reason: String },
    /// The source was read to its end and returned `records` records
    /// (`0` is a genuine empty read, which is not evidence that the season
    /// has no transactions), the earliest and latest slot among them.
    Fetched {
        records: u64,
        first_slot: Option<u64>,
        last_slot: Option<u64>,
    },
    /// The source reported that its history has a gap.
    Gap { detail: String },
    /// A recorded `history` block this verifier cannot read (never
    /// upgraded to anything better).
    Malformed { detail: String },
}

/// The history evidence of one input: source, observation, and the
/// independent observations it was compared with. Agreement between
/// observations (`cross_checked`) is context for the reader only: it is
/// not proof of completeness, nor of finality, and never changes the
/// verdict upward.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEvidence {
    pub source: HistorySource,
    pub observation: HistoryObservation,
    pub cross_checked: Vec<String>,
}

/// What the evidence lets the verifier claim (`HistoryEvidence::assurance`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Assurance {
    /// Judged as a dataset: the verdict is about the transactions given,
    /// not a claim that they are the season's whole on-chain history.
    DatasetOnly,
    /// A local node's own feed: whole only insofar as that node is the
    /// whole chain (the harness); judged as a dataset, labelled apart.
    LocalFeed,
    /// A real-chain source read in full, with nothing to show its history
    /// is whole: `Unverifiable`.
    Unverifiable,
    /// The source returned no transactions: `Unverifiable`.
    EmptyObservation,
    /// The source reported a gap: `Unverifiable`.
    Gap,
    /// The source was named but not read, or a read source (a feed, an
    /// archive, a poll) with no observation recorded: `Unverifiable`.
    NotObserved,
    /// The recorded evidence cannot be read: `Unverifiable`.
    Malformed,
}

impl Assurance {
    pub fn name(self) -> &'static str {
        match self {
            Assurance::DatasetOnly => "dataset-only",
            Assurance::LocalFeed => "local-feed",
            Assurance::Unverifiable => "unverifiable",
            Assurance::EmptyObservation => "empty-observation",
            Assurance::Gap => "gap",
            Assurance::NotObserved => "not-observed",
            Assurance::Malformed => "malformed",
        }
    }
    /// The verdict judges the dataset given (no V0H finding; the report
    /// labels the scope).
    pub fn judged_as_dataset(self) -> bool {
        matches!(self, Assurance::DatasetOnly | Assurance::LocalFeed)
    }
}

impl HistoryEvidence {
    pub fn unstated() -> HistoryEvidence {
        HistoryEvidence {
            source: HistorySource::Unstated,
            observation: HistoryObservation::Unstated,
            cross_checked: vec![],
        }
    }

    /// A dataset built or cut in code (nothing was fetched).
    pub fn dataset(label: impl Into<String>) -> HistoryEvidence {
        HistoryEvidence {
            source: HistorySource::Dataset {
                label: label.into(),
            },
            observation: HistoryObservation::Unstated,
            cross_checked: vec![],
        }
    }

    /// The observation of `txs` read in full from `source`.
    pub fn fetched(source: HistorySource, txs: &[TxRecord]) -> HistoryEvidence {
        HistoryEvidence {
            source,
            observation: HistoryObservation::Fetched {
                records: txs.len() as u64,
                first_slot: txs.iter().map(|t| t.slot).min(),
                last_slot: txs.iter().map(|t| t.slot).max(),
            },
            cross_checked: vec![],
        }
    }

    /// A local node's own feed read in full (the harness).
    pub fn local_feed(url: impl Into<String>, txs: &[TxRecord]) -> HistoryEvidence {
        HistoryEvidence::fetched(HistorySource::LocalnetFeed { url: url.into() }, txs)
    }

    pub fn assurance(&self) -> Assurance {
        match &self.observation {
            HistoryObservation::Malformed { .. } => Assurance::Malformed,
            HistoryObservation::NotFetched { .. } => Assurance::NotObserved,
            HistoryObservation::Gap { .. } => Assurance::Gap,
            // Bounds that cannot have come from a read are not an
            // observation (a hand-built value; the file form is refused
            // earlier, in `from_json`).
            HistoryObservation::Fetched {
                records,
                first_slot,
                last_slot,
            } if !bounds_coherent(*records, *first_slot, *last_slot) => Assurance::Malformed,
            HistoryObservation::Fetched { records: 0, .. } => Assurance::EmptyObservation,
            // No observation at all: a dataset is judged as one; a source
            // that is read (a feed, an archive, a poll) without saying what
            // the read returned was not observed.
            HistoryObservation::Unstated => match &self.source {
                HistorySource::Unstated | HistorySource::Dataset { .. } => Assurance::DatasetOnly,
                HistorySource::LocalnetFeed { .. }
                | HistorySource::Archive { .. }
                | HistorySource::RpcPoll { .. } => Assurance::NotObserved,
            },
            HistoryObservation::Fetched { .. } => match &self.source {
                HistorySource::Unstated | HistorySource::Dataset { .. } => Assurance::DatasetOnly,
                HistorySource::LocalnetFeed { .. } => Assurance::LocalFeed,
                HistorySource::Archive { .. } | HistorySource::RpcPoll { .. } => {
                    Assurance::Unverifiable
                }
            },
        }
    }

    /// One line for the report: source, observation and bounds.
    pub fn describe(&self) -> String {
        let src = match &self.source {
            HistorySource::Unstated => "source unstated".to_string(),
            HistorySource::Dataset { label } => format!("dataset ({label})"),
            HistorySource::Archive { dir } => format!("findex archive {dir}"),
            HistorySource::RpcPoll { url } => format!("one node's signature poll at {url}"),
            HistorySource::LocalnetFeed { url } => format!("local node's own feed at {url}"),
        };
        let obs = match &self.observation {
            HistoryObservation::Unstated => "no observation recorded".to_string(),
            HistoryObservation::NotFetched { reason } => format!("not fetched: {reason}"),
            HistoryObservation::Fetched {
                records,
                first_slot,
                last_slot,
            } => match (first_slot, last_slot) {
                (Some(a), Some(b)) => format!("read in full: {records} records, slots {a}–{b}"),
                _ => format!("read in full: {records} records"),
            },
            HistoryObservation::Gap { detail } => format!("gap reported: {detail}"),
            HistoryObservation::Malformed { detail } => format!("malformed evidence: {detail}"),
        };
        let xc = if self.cross_checked.is_empty() {
            String::new()
        } else {
            format!(
                "; cross-checked with {} (context only: not proof of completeness or finality)",
                self.cross_checked.join(", ")
            )
        };
        format!("{src}; {obs}{xc}")
    }

    pub fn to_json(&self) -> Value {
        let source = match &self.source {
            HistorySource::Unstated => json!({"kind": "unstated"}),
            HistorySource::Dataset { label } => json!({"kind": "dataset", "label": label}),
            HistorySource::Archive { dir } => json!({"kind": "archive", "dir": dir}),
            HistorySource::RpcPoll { url } => json!({"kind": "rpc_poll", "url": url}),
            HistorySource::LocalnetFeed { url } => json!({"kind": "localnet_feed", "url": url}),
        };
        let observation = match &self.observation {
            HistoryObservation::Unstated => json!({"kind": "unstated"}),
            HistoryObservation::NotFetched { reason } => {
                json!({"kind": "not_fetched", "reason": reason})
            }
            HistoryObservation::Fetched {
                records,
                first_slot,
                last_slot,
            } => {
                json!({"kind": "fetched", "records": records, "first_slot": first_slot, "last_slot": last_slot})
            }
            HistoryObservation::Gap { detail } => json!({"kind": "gap", "detail": detail}),
            HistoryObservation::Malformed { detail } => {
                json!({"kind": "malformed", "detail": detail})
            }
        };
        json!({
            "source": source,
            "observation": observation,
            "cross_checked": self.cross_checked,
            "assurance": self.assurance().name(),
        })
    }

    /// Reads a `history` block, fail closed: anything this verifier cannot
    /// read exactly is [`HistoryObservation::Malformed`], never an error
    /// that stops the load and never a better observation. Every named
    /// field must be present with its type (a string label, directory or
    /// url; a string reason or detail; an unsigned `records`; slot bounds
    /// absent or `null` only where a read can legitimately have none,
    /// see [`bounds_coherent`]; `cross_checked` absent, `null` or an
    /// array of strings). `assurance` in the file is ignored: it is
    /// derived, not declared.
    pub fn from_json(v: &Value) -> HistoryEvidence {
        match Self::parse(v) {
            Ok(h) => h,
            Err(detail) => HistoryEvidence {
                source: HistorySource::Unstated,
                observation: HistoryObservation::Malformed { detail },
                cross_checked: vec![],
            },
        }
    }

    fn parse(v: &Value) -> Result<HistoryEvidence, String> {
        // A field that must be a string.
        let s = |x: &Value, at: &str, k: &str| -> Result<String, String> {
            match x.get(k) {
                Some(Value::String(s)) => Ok(s.clone()),
                Some(_) => Err(format!("history.{at}.{k} is not a string")),
                None => Err(format!("history.{at}.{k} is absent")),
            }
        };
        // A field that must be an unsigned integer.
        let u = |x: &Value, at: &str, k: &str| -> Result<u64, String> {
            match x.get(k) {
                Some(Value::Number(n)) => n
                    .as_u64()
                    .ok_or(format!("history.{at}.{k} is not an unsigned integer")),
                Some(_) => Err(format!("history.{at}.{k} is not an unsigned integer")),
                None => Err(format!("history.{at}.{k} is absent")),
            }
        };
        // A slot bound: absent or null is "none"; anything else an
        // unsigned integer.
        let slot = |x: &Value, k: &str| -> Result<Option<u64>, String> {
            match x.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(_) => u(x, "observation", k).map(Some),
            }
        };
        let obj = v.as_object().ok_or("history is not an object")?;
        let sv = obj.get("source").ok_or("history.source is absent")?;
        let source = match s(sv, "source", "kind")?.as_str() {
            "unstated" => HistorySource::Unstated,
            "dataset" => HistorySource::Dataset {
                label: s(sv, "source", "label")?,
            },
            "archive" => HistorySource::Archive {
                dir: s(sv, "source", "dir")?,
            },
            "rpc_poll" => HistorySource::RpcPoll {
                url: s(sv, "source", "url")?,
            },
            "localnet_feed" => HistorySource::LocalnetFeed {
                url: s(sv, "source", "url")?,
            },
            other => {
                return Err(format!(
                    "history.source.kind {other:?} is not one this verifier reads"
                ))
            }
        };
        let ov = obj
            .get("observation")
            .ok_or("history.observation is absent")?;
        let observation = match s(ov, "observation", "kind")?.as_str() {
            "unstated" => HistoryObservation::Unstated,
            "not_fetched" => HistoryObservation::NotFetched {
                reason: s(ov, "observation", "reason")?,
            },
            "fetched" => {
                let records = u(ov, "observation", "records")?;
                let first_slot = slot(ov, "first_slot")?;
                let last_slot = slot(ov, "last_slot")?;
                if !bounds_coherent(records, first_slot, last_slot) {
                    return Err(format!(
                        "history.observation: {records} records with slot bounds {first_slot:?}–{last_slot:?} is not a possible read"
                    ));
                }
                HistoryObservation::Fetched {
                    records,
                    first_slot,
                    last_slot,
                }
            }
            "gap" => HistoryObservation::Gap {
                detail: s(ov, "observation", "detail")?,
            },
            "malformed" => HistoryObservation::Malformed {
                detail: s(ov, "observation", "detail")?,
            },
            other => {
                return Err(format!(
                    "history.observation.kind {other:?} is not one this verifier reads"
                ))
            }
        };
        let cross_checked = match obj.get("cross_checked") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| match x {
                    Value::String(s) => Ok(s.clone()),
                    _ => Err("history.cross_checked has an entry that is not a string".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => return Err("history.cross_checked is not an array".into()),
        };
        Ok(HistoryEvidence {
            source,
            observation,
            cross_checked,
        })
    }
}

/// Whether `records` with these slot bounds can have come from one read:
/// no records means no bounds; exactly one record means both bounds equal
/// (one record has one slot); two or more records mean both bounds, in
/// order (they may share a slot). Anything else (one-sided or reversed
/// bounds, bounds on an empty read, no bounds on a non-empty one, a
/// single record spanning two slots) is not an observation.
pub fn bounds_coherent(records: u64, first_slot: Option<u64>, last_slot: Option<u64>) -> bool {
    match (records, first_slot, last_slot) {
        (0, None, None) => true,
        (0, _, _) => false,
        (1, Some(a), Some(b)) => a == b,
        (_, Some(a), Some(b)) => a <= b,
        _ => false,
    }
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
    /// How the transactions were observed (V0H judges it).
    pub history: HistoryEvidence,
}

impl Input {
    pub fn to_json(&self) -> Value {
        json!({
            "format": FIXTURE_FORMAT,
            "provenance": self.provenance,
            "scenarios": self.scenarios,
            "config": self.cfg.to_json(),
            "final_slot": self.final_slot,
            "program_hashes": self.program_hashes.iter().map(|(s, h)| json!([s, hex::encode(h)])).collect::<Vec<_>>(),
            "history": self.history.to_json(),
            "txs": self.txs.iter().map(findex::archive::record_to_json).collect::<Vec<_>>(),
            "finals": self.finals.iter().map(|(k, a)| json!([Address::new_from_array(*k).to_string(), a.as_ref().map(account_json)])).collect::<Vec<_>>(),
        })
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
            // A file without the block is a legacy fixture: unstated, judged
            // as a dataset and labelled so. A block is read fail-closed.
            history: match v.get("history") {
                None => HistoryEvidence::unstated(),
                Some(h) => HistoryEvidence::from_json(h),
            },
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
        if let Ok(tx) = fclient::tx::from_wire(&t.tx) {
            for (i, k) in tx.message.account_keys.iter().enumerate() {
                if fclient::tx::is_writable_index(&tx.message, i) {
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

/// Reads a findex archive directory (`manifest.json` + segments).
pub fn read_archive(dir: &Path) -> Result<Vec<TxRecord>, String> {
    read_archive_observed(dir).map(|(t, _)| t)
}

/// [`read_archive`] with what was observed: the archive's integrity is
/// verified (sealed segments by hash, sequence numbers contiguous), which
/// proves the archive is whole as written, not that the ingest saw every
/// transaction of the season. Its evidence is therefore
/// [`HistorySource::Archive`] read in full, which V0H judges
/// `Unverifiable` (workstream 19's coverage data is not in this tree; see
/// `HISTORY-EVIDENCE.md`).
pub fn read_archive_observed(dir: &Path) -> Result<(Vec<TxRecord>, HistoryEvidence), String> {
    let a = findex::archive::Archive::open(dir, findex::archive::SEGMENT_BYTES)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    a.verify()?;
    let txs = a.read_after(0).map_err(|e| e.to_string())?;
    let h = HistoryEvidence::fetched(
        HistorySource::Archive {
            dir: dir.display().to_string(),
        },
        &txs,
    );
    Ok((txs, h))
}

/// Whether a source error is `findex::ingest::RpcPoll`'s history-gap
/// refusal (the node's history no longer reaches what was read, or skips
/// a signature between two pages): the transactions read so far are a
/// known-partial history, so nothing is verified on them.
pub fn is_history_gap(err: &str) -> bool {
    err.contains("history gap")
}

/// The final states of `keys` and the slot they were read at, over RPC.
pub async fn fetch_finals(
    url: &str,
    keys: &[Address],
) -> Result<(BTreeMap<Key, Option<Account>>, u64), String> {
    use fclient::ports::ChainPort;
    let port = fclient::rpc::RpcPort::new(url, Address::default());
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
    let c = fclient::rpc::RpcClient::new(url);
    let v = c
        .call(
            "getProgramAccounts",
            serde_json::json!([program.to_string(), {"encoding": "base64", "commitment": "confirmed"}]),
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
        if data.get(8..16).map(crate::world::le) == Some(season_id) {
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
    let port = fclient::rpc::RpcPort::new(url, *program);
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

/// The program's transactions over RPC: `frontier_feed` on a local node,
/// else `getSignaturesForAddress` + `getTransaction` (findex `RpcPoll`).
pub async fn fetch_txs(
    url: &str,
    program: &Address,
    localnet: bool,
) -> Result<Vec<TxRecord>, String> {
    observe_txs(url, program, localnet).await.map(|(t, _)| t)
}

/// [`fetch_txs`] with what was observed: a local node's own feed
/// ([`HistorySource::LocalnetFeed`], judged as the harness's dataset) or
/// one node's signature poll ([`HistorySource::RpcPoll`], which V0H judges
/// `Unverifiable`: one node cannot show a gap on its first pull, nor a
/// range its own history lacks). A gap the poll does detect is an `Err`
/// ([`is_history_gap`]): the transactions read before it are a known
/// partial history and are not handed back.
pub async fn observe_txs(
    url: &str,
    program: &Address,
    localnet: bool,
) -> Result<(Vec<TxRecord>, HistoryEvidence), String> {
    let txs = pull_txs(url, program, localnet).await?;
    let source = if localnet {
        HistorySource::LocalnetFeed { url: url.into() }
    } else {
        HistorySource::RpcPoll { url: url.into() }
    };
    let h = HistoryEvidence::fetched(source, &txs);
    Ok((txs, h))
}

async fn pull_txs(url: &str, program: &Address, localnet: bool) -> Result<Vec<TxRecord>, String> {
    use findex::ingest::Source;
    let mut out = vec![];
    if localnet {
        let mut s =
            findex::ingest::LocalnetFeed::new(fclient::rpc::RpcPort::localnet(url, *program));
        loop {
            let b = s.pull().await.map_err(|e| e.to_string())?;
            if b.is_empty() {
                break;
            }
            out.extend(b);
        }
    } else {
        let mut s = findex::ingest::RpcPoll::new(url, *program);
        loop {
            let b = s.pull().await.map_err(|e| e.to_string())?;
            if b.is_empty() {
                break;
            }
            out.extend(b);
        }
    }
    Ok(out)
}

/// History evidence, on plain data only (no key, signature, address
/// derivation, file or network: literal byte arrays and JSON).
#[cfg(test)]
mod history_tests {
    use super::*;

    /// A transaction record of literal bytes (nothing is signed; the
    /// verifier never checks signatures).
    fn rec(slot: u64) -> TxRecord {
        TxRecord {
            seq: slot,
            slot,
            signature: fclient::ports::Signature::from([slot as u8; 64]),
            block_time: 0,
            tx: vec![],
            logs: vec![],
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![],
        }
    }

    #[test]
    fn history_assurance_follows_source_and_observation() {
        use Assurance as A;
        let txs = [rec(10), rec(12), rec(11)];
        let rpc = HistorySource::RpcPoll { url: "u".into() };
        let arc = HistorySource::Archive { dir: "d".into() };
        let feed = HistorySource::LocalnetFeed { url: "u".into() };
        assert_eq!(HistoryEvidence::unstated().assurance(), A::DatasetOnly);
        assert_eq!(HistoryEvidence::dataset("x").assurance(), A::DatasetOnly);
        assert_eq!(
            HistoryEvidence::local_feed("u", &txs).assurance(),
            A::LocalFeed
        );
        assert_eq!(
            HistoryEvidence::fetched(rpc.clone(), &txs).assurance(),
            A::Unverifiable
        );
        assert_eq!(
            HistoryEvidence::fetched(arc.clone(), &txs).assurance(),
            A::Unverifiable
        );
        // Bounds come from the records, whatever their order.
        assert_eq!(
            HistoryEvidence::fetched(arc.clone(), &txs).observation,
            HistoryObservation::Fetched {
                records: 3,
                first_slot: Some(10),
                last_slot: Some(12)
            }
        );
        // An empty read is a genuine observation, and not evidence of an
        // empty season: never judged as a dataset, from any source.
        for src in [
            rpc.clone(),
            arc.clone(),
            feed,
            HistorySource::Dataset { label: "x".into() },
        ] {
            assert_eq!(
                HistoryEvidence::fetched(src, &[]).assurance(),
                A::EmptyObservation
            );
        }
        // Gap, not fetched and malformed are each their own, from any source.
        let with = |o: HistoryObservation| HistoryEvidence {
            source: rpc.clone(),
            observation: o,
            cross_checked: vec![],
        };
        assert_eq!(
            with(HistoryObservation::Gap { detail: "g".into() }).assurance(),
            A::Gap
        );
        assert_eq!(
            with(HistoryObservation::NotFetched { reason: "r".into() }).assurance(),
            A::NotObserved
        );
        assert_eq!(
            with(HistoryObservation::Malformed { detail: "m".into() }).assurance(),
            A::Malformed
        );
        // No observation: a dataset is judged as one; a read source that
        // does not say what the read returned was not observed (a local
        // feed included: it is not the harness's dataset until read).
        let unstated = |source: HistorySource| HistoryEvidence {
            source,
            observation: HistoryObservation::Unstated,
            cross_checked: vec![],
        };
        assert_eq!(
            unstated(HistorySource::Unstated).assurance(),
            A::DatasetOnly
        );
        assert_eq!(
            unstated(HistorySource::Dataset { label: "x".into() }).assurance(),
            A::DatasetOnly
        );
        assert_eq!(
            unstated(HistorySource::LocalnetFeed { url: "u".into() }).assurance(),
            A::NotObserved
        );
        assert_eq!(unstated(arc.clone()).assurance(), A::NotObserved);
        assert_eq!(unstated(rpc.clone()).assurance(), A::NotObserved);
        // A hand-built read whose bounds no read can produce is malformed.
        for (records, lo, hi) in [
            (0, Some(1), Some(2)),
            (0, None, Some(2)),
            (2, None, None),
            (2, Some(1), None),
            (2, Some(3), Some(2)),
            // One record cannot span two slots (review of 2026-11-07).
            (1, Some(4), Some(9)),
            (1, Some(9), Some(4)),
            (1, Some(4), None),
            (1, None, None),
        ] {
            let bad = HistoryEvidence {
                source: HistorySource::LocalnetFeed { url: "u".into() },
                observation: HistoryObservation::Fetched {
                    records,
                    first_slot: lo,
                    last_slot: hi,
                },
                cross_checked: vec![],
            };
            assert_eq!(bad.assurance(), A::Malformed, "{records} {lo:?} {hi:?}");
            assert!(!bounds_coherent(records, lo, hi));
        }
        assert!(bounds_coherent(0, None, None));
        assert!(bounds_coherent(1, Some(4), Some(4)));
        assert!(bounds_coherent(2, Some(4), Some(9)));
        // Several records may share one slot.
        assert!(bounds_coherent(2, Some(4), Some(4)));
        assert!(bounds_coherent(3, Some(4), Some(4)));
        // A single-record local feed is the harness's dataset only with
        // equal bounds; the builder produces exactly that.
        let one = HistoryEvidence::local_feed("u", &[rec(4)]);
        assert_eq!(
            one.observation,
            HistoryObservation::Fetched {
                records: 1,
                first_slot: Some(4),
                last_slot: Some(4)
            }
        );
        assert_eq!(one.assurance(), A::LocalFeed);
        let two_same_slot = HistoryEvidence::local_feed("u", &[rec(4), rec(4)]);
        assert_eq!(two_same_slot.assurance(), A::LocalFeed);
        // A cross-check is context: it changes no assurance.
        let mut x = HistoryEvidence::fetched(rpc, &txs);
        x.cross_checked
            .push("rpc https://other: same 3 signatures".into());
        assert_eq!(x.assurance(), A::Unverifiable);
        assert!(x
            .describe()
            .contains("not proof of completeness or finality"));
        assert!(A::DatasetOnly.judged_as_dataset() && A::LocalFeed.judged_as_dataset());
        for a in [
            A::Unverifiable,
            A::EmptyObservation,
            A::Gap,
            A::NotObserved,
            A::Malformed,
        ] {
            assert!(!a.judged_as_dataset(), "{}", a.name());
        }
    }

    #[test]
    fn history_json_round_trips_and_never_declares_completeness() {
        let txs = [rec(5), rec(9)];
        let cases = vec![
            HistoryEvidence::unstated(),
            HistoryEvidence::dataset("a slice"),
            HistoryEvidence::local_feed("http://127.0.0.1:1", &txs),
            HistoryEvidence::fetched(
                HistorySource::RpcPoll {
                    url: "http://n".into(),
                },
                &txs,
            ),
            HistoryEvidence::fetched(HistorySource::Archive { dir: "/a".into() }, &[]),
            HistoryEvidence {
                source: HistorySource::Archive { dir: "/a".into() },
                observation: HistoryObservation::Gap {
                    detail: "sig x lies between".into(),
                },
                cross_checked: vec!["node b: same count".into()],
            },
            HistoryEvidence {
                source: HistorySource::Unstated,
                observation: HistoryObservation::NotFetched {
                    reason: "no rpc".into(),
                },
                cross_checked: vec![],
            },
        ];
        for h in cases {
            let j = h.to_json();
            assert_eq!(j["assurance"], h.assurance().name(), "{j}");
            assert_eq!(HistoryEvidence::from_json(&j), h, "{j}");
        }
        // `assurance` in a file is derived, never read: a file that says
        // "complete" against an unverifiable source is still unverifiable.
        let mut j =
            HistoryEvidence::fetched(HistorySource::RpcPoll { url: "u".into() }, &txs).to_json();
        j["assurance"] = json!("complete");
        assert_eq!(
            HistoryEvidence::from_json(&j).assurance(),
            Assurance::Unverifiable
        );
        // A cross-check recorded in a file is kept as context only.
        j["cross_checked"] = json!(["node b: same 2 signatures"]);
        let h = HistoryEvidence::from_json(&j);
        assert_eq!(h.cross_checked.len(), 1);
        assert_eq!(h.assurance(), Assurance::Unverifiable);
        // Null slot bounds are read as none where a read can have none.
        let empty = json!({"source": {"kind": "archive", "dir": "/a"},
            "observation": {"kind": "fetched", "records": 0, "first_slot": null, "last_slot": null}});
        assert_eq!(
            HistoryEvidence::from_json(&empty).observation,
            HistoryObservation::Fetched {
                records: 0,
                first_slot: None,
                last_slot: None
            }
        );
    }

    /// Literal JSON that must not be read as an observation (regression,
    /// review of 2026-11-07): slot bounds that are negative, fractional,
    /// strings, one-sided or reversed; bounds on an empty read; no bounds
    /// on a non-empty read; source and cross-check fields of the wrong
    /// type. Each is `Malformed`, never `Fetched` with a lenient value.
    #[test]
    fn history_fetched_bounds_and_field_types_fail_closed() {
        let fetched = |records: Value, lo: Value, hi: Value| {
            json!({"source": {"kind": "rpc_poll", "url": "u"},
                "observation": {"kind": "fetched", "records": records, "first_slot": lo, "last_slot": hi}})
        };
        let malformed = |v: Value| {
            let h = HistoryEvidence::from_json(&v);
            assert!(
                matches!(h.observation, HistoryObservation::Malformed { .. }),
                "{v}: {h:?}"
            );
            assert_eq!(h.assurance(), Assurance::Malformed, "{v}");
        };
        // Bounds of the wrong type (each alone, the other side valid).
        for bad in [
            json!(-1),
            json!(1.5),
            json!("3"),
            json!(true),
            json!([3]),
            json!({}),
        ] {
            malformed(fetched(json!(2), bad.clone(), json!(9)));
            malformed(fetched(json!(2), json!(1), bad));
        }
        // Records of the wrong type.
        for bad in [json!(-1), json!(1.5), json!("2"), json!(null), json!(true)] {
            malformed(fetched(bad, json!(1), json!(9)));
        }
        // One-sided, reversed, bounds on an empty read, none on a read.
        malformed(fetched(json!(2), json!(1), json!(null)));
        malformed(fetched(json!(2), json!(null), json!(9)));
        malformed(fetched(json!(2), json!(9), json!(1)));
        malformed(fetched(json!(0), json!(1), json!(1)));
        malformed(fetched(json!(0), json!(null), json!(1)));
        malformed(fetched(json!(2), json!(null), json!(null)));
        // A single record spanning two slots, or with one bound only
        // (review of 2026-11-07).
        malformed(fetched(json!(1), json!(4), json!(9)));
        malformed(fetched(json!(1), json!(9), json!(4)));
        malformed(fetched(json!(1), json!(4), json!(null)));
        malformed(fetched(json!(1), json!(null), json!(null)));
        // A good read, for contrast: the one-record case with equal
        // bounds, a span, and several records sharing one slot.
        for (r, lo, hi) in [(2, 1, 9), (1, 4, 4), (3, 4, 4)] {
            assert_eq!(
                HistoryEvidence::from_json(&fetched(json!(r), json!(lo), json!(hi))).observation,
                HistoryObservation::Fetched {
                    records: r,
                    first_slot: Some(lo),
                    last_slot: Some(hi)
                }
            );
        }
        // Source fields that are absent or not strings.
        let obs = json!({"kind": "unstated"});
        malformed(json!({"source": {"kind": "dataset"}, "observation": obs}));
        malformed(json!({"source": {"kind": "dataset", "label": 7}, "observation": obs}));
        malformed(json!({"source": {"kind": "archive"}, "observation": obs}));
        malformed(json!({"source": {"kind": "archive", "dir": null}, "observation": obs}));
        malformed(json!({"source": {"kind": "rpc_poll", "url": ["u"]}, "observation": obs}));
        malformed(json!({"source": {"kind": "localnet_feed"}, "observation": obs}));
        malformed(json!({"source": {"kind": 1}, "observation": obs}));
        malformed(json!({"source": "rpc_poll", "observation": obs}));
        // Observation fields that are absent or not strings.
        let src = json!({"kind": "rpc_poll", "url": "u"});
        malformed(json!({"source": src, "observation": {"kind": "gap"}}));
        malformed(json!({"source": src, "observation": {"kind": "gap", "detail": 3}}));
        malformed(json!({"source": src, "observation": {"kind": "not_fetched"}}));
        malformed(json!({"source": src, "observation": {"kind": "malformed", "detail": null}}));
        malformed(json!({"source": src, "observation": "fetched"}));
        // Cross-check entries that are not strings.
        for bad in [
            json!([{"node": "b"}]),
            json!([1]),
            json!(["ok", null]),
            json!("b"),
            json!({}),
        ] {
            malformed(json!({"source": src, "observation": obs, "cross_checked": bad}));
        }
    }

    #[test]
    fn history_unknown_or_broken_blocks_are_malformed_not_upgraded() {
        let malformed = |v: Value| {
            let h = HistoryEvidence::from_json(&v);
            assert!(
                matches!(h.observation, HistoryObservation::Malformed { .. }),
                "{v}: {h:?}"
            );
            assert_eq!(h.assurance(), Assurance::Malformed);
        };
        malformed(json!(null));
        malformed(json!("complete"));
        malformed(json!({}));
        malformed(
            json!({"source": {"kind": "complete"}, "observation": {"kind": "fetched", "records": 1}}),
        );
        malformed(json!({"source": {"kind": "rpc_poll", "url": "u"}}));
        malformed(
            json!({"source": {"kind": "rpc_poll", "url": "u"}, "observation": {"kind": "complete"}}),
        );
        malformed(
            json!({"source": {"kind": "rpc_poll", "url": "u"}, "observation": {"kind": "fetched"}}),
        );
        malformed(
            json!({"source": {"kind": "rpc_poll", "url": "u"}, "observation": {"kind": "fetched", "records": -1}}),
        );
        malformed(
            json!({"source": {"kind": "unstated"}, "observation": {"kind": "unstated"}, "cross_checked": "b"}),
        );
    }

    /// `Input::from_json`: a file without the block is a legacy fixture
    /// (unstated: judged as a dataset); a file with one keeps it. The
    /// fixture here is literal: a 32-byte program id, zero keys, no
    /// transactions, no accounts.
    #[test]
    fn history_input_without_the_block_is_unstated_and_with_it_is_kept() {
        let mut v = json!({
            "format": FIXTURE_FORMAT,
            "config": {
                "program": Address::new_from_array([7u8; 32]).to_string(),
                "season_id": 1,
                "quicknet_pk": "00".repeat(96),
                "ruleset_hash": "11".repeat(32),
            },
            "final_slot": 0,
            "txs": [],
            "finals": [],
        });
        let legacy = Input::from_json(&v).expect("a legacy fixture loads");
        assert_eq!(legacy.history, HistoryEvidence::unstated());
        assert_eq!(legacy.history.assurance(), Assurance::DatasetOnly);
        let h = HistoryEvidence::fetched(HistorySource::Archive { dir: "/x".into() }, &[rec(3)]);
        v["history"] = h.to_json();
        let kept = Input::from_json(&v).expect("loads");
        assert_eq!(kept.history, h);
        assert_eq!(kept.to_json()["history"], h.to_json());
        v["history"] = json!({"complete": true});
        let broken = Input::from_json(&v).expect("a broken block does not stop the load");
        assert_eq!(broken.history.assurance(), Assurance::Malformed);
    }
}
