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

/// The ledger a local node serves (`frontier_status.runId`), if it says.
pub async fn ledger_id(url: &str) -> Option<String> {
    let v = fclient::rpc::RpcClient::new(url)
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
    if let Some(o) = origin {
        s = s.with_origin(o);
    }
    if let Some(w) = witness {
        s = s.with_witness(w);
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
