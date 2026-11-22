//! VS — a second, independent source for a public-RPC season (⑰ prize gate,
//! owner Q-P1 = (a) + (b), 2026-11-19 22:32).
//!
//! An RPC that lies can serve a consistent false season: signed transactions
//! that never landed, a transaction left out, a log line, an error, a
//! balance or a final state edited. The transaction bytes are signed, but a
//! signature shows only that the signers authorised the message, not that
//! the cluster included it; everything else (`meta`, the slot, the block,
//! the finals) is the RPC's word (verify-pr91 §4, residual 6). VG (`(a)`,
//! `genesis.rs`) proves that the archived transactions, in their order,
//! leave every program-owned final state exactly; it cannot see that the
//! archive is the chain's. VS asks one or more **witness** RPCs (`--witness
//! URL`, repeatable) for the same season and requires that they serve the
//! same thing, item by item:
//!
//! 1. the same cluster (`getGenesisHash`), and a witness whose endpoint is
//!    not the primary's nor another witness's ([`same_source`]: the same
//!    host in any spelling, port, path or query; for a loopback host the
//!    same port);
//! 2. the program's whole finalized signature list (`getSignaturesForAddress`
//!    paged to its end, failed transactions included) up to the later of
//!    the two final-state slots: every signature the witness lists is
//!    archived (else a transaction is **missing** from the primary's
//!    history), and every archived one is listed, at its slot, with its
//!    failure flag (else it is **unknown** to the witness: never landed, or
//!    not finalized);
//! 3. each archived transaction as the witness serves it at `finalized`:
//!    the same wire bytes, slot, block time, error, fee, compute units,
//!    log lines and `meta.preBalances` / `postBalances`;
//! 4. the block of every archived transaction's slot (`getBlock`, signatures
//!    only): the same blockhash, previous blockhash, parent slot and height
//!    on both sources, and the transaction among the block's signatures on
//!    both (inclusion in the block store, a different index than the
//!    signature list of 2.), and the archive's order of the slot's
//!    transactions the block's on both (verify-pr103: VG re-executes in the
//!    archive's order, and the archive's slots never go back either; an
//!    order no witness serves is a `WitnessMismatch`, so ⑰ Q-P2 cannot make
//!    a misordered honest season FAIL);
//! 5. the program's account set of the season (`getProgramAccounts`, the
//!    season id at offset 8) and the final state of every program-owned
//!    account (data, owner, lamports, executable);
//! 6. the deployed binary (the ProgramData's ELF sha256) and its upgrade
//!    authority;
//! 7. (verifier-alt-archive, F1 / F2 of verify-pr155) when the archive has
//!    v0 transactions with lookups: the witness's own read of every lookup
//!    table they name, at its final-state slot, whose body must agree with
//!    the primary's read (two reads of an append-only table are
//!    prefix-compatible, the same at one slot, never reopened once closed,
//!    the authority never changed but to none) — and **every lookup
//!    confirmed on the witness's own reads**: its table read holds the
//!    archived address at the index, or (a table closed since) the
//!    snapshot's create / extend transactions, as the WITNESS serves them
//!    (the same bytes, slot and error as archived), replay to it
//!    ([`fclient::alt::replay`]). A lookup no witness read confirms is
//!    `WitnessUnavailable`: an account-only snapshot of a closed table can
//!    never be confirmed (no RPC serves an old account state), so such a
//!    season stays `unproven`.
//!
//! Every item the witness could not serve (unreachable, behind the primary,
//! a block not available, a page served twice) is `WitnessUnavailable`;
//! every disagreement is `WitnessMissingTx`, `WitnessUnknownTx` or
//! `WitnessMismatch`. All are UNVERIFIABLE, not FAIL: two sources that
//! disagree show that one of them lies, not which one, and not that the
//! **season** is bad (its FAIL needs the season shown bad over data both
//! agree on; the self-contained FAILs of `history.rs` stay FAIL whatever).
//!
//! **The verdict rule** (`history::apply`): a public-RPC history stops being
//! `unproven` (basis `witnessed`) only when (a) VG re-executed the whole
//! archive from the Season's creation with no finding at all (every
//! program-owned final state reproduced exactly), AND (b) at least one
//! witness was read and VS has no finding for any witness. Then the season
//! is judged as a whole history: PASS, or FAIL on any FAIL finding.
//! **⑰ Q-P2 = FAIL** (owner 2026-11-20): when (b) holds and VG ran with a
//! FAIL finding, both sources serve a season the pinned program does not
//! produce: the verdict is FAIL (`history.failBasis` `vg_witnessed`), the
//! history stays `unproven`, and agreement never lifts it to a PASS.
//!
//! **What stays trusted** (the residual, stated in every report): the
//! witnesses are independent of the primary. Two RPCs that collude, or that
//! read one storage or one compromised validator, can serve the same false
//! season and pass (`complete` stays `null`: a dataset claim over agreeing
//! sources). Our own node, its ledger replayed from a snapshot we fetched
//! ourselves, is the strongest witness; Old Faithful's CAR archives (content
//! addressed) are another storage, but their root CID still comes from
//! someone. No RPC exposes a bank hash with a proof of inclusion, so nothing
//! here is a light client: block identities agree, they are not verified
//! against validator votes. Only the blocks of the archive's slots are
//! compared, not the whole parent chain between them. A lamport credit to a
//! program account by a transaction that does not name the program (a
//! System transfer) is not on the program's signature list of either
//! source; VG takes credits from the chain's balances (genesis.rs).

use std::collections::{BTreeMap, BTreeSet};

use fclient::ports::{Account, TxRecord};
use fclient::rpc::{account_json, parse_account, RpcClient};
use serde_json::{json, Value};
use solana_address::Address;

use crate::codes::{WITNESS_MISMATCH, WITNESS_MISSING_TX, WITNESS_UNAVAILABLE, WITNESS_UNKNOWN_TX};
use crate::input::{Balances, Input};
use crate::world::{b58, Key};
use crate::{Finding, Severity};

pub const CHECK: &str = "VS";

/// What stays trusted when the witnesses agree (report text).
pub const RESIDUAL: &str = "the witnesses are independent of the primary RPC: two RPCs that collude, that read one storage or one compromised validator, or a witness that proxies the primary (only one host given twice is refused) can serve the same false season and pass. Block identities agree between the sources; they are not verified against validator votes";

/// A block as `getBlock` (transactionDetails `signatures`) serves it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Block {
    pub blockhash: String,
    pub previous: String,
    pub parent_slot: u64,
    pub height: Option<u64>,
    pub signatures: Vec<String>,
}

/// A transaction as a source serves it (`getTransaction`, finalized).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Served {
    pub slot: u64,
    pub block_time: i64,
    pub tx: Vec<u8>,
    pub logs: Vec<String>,
    pub err: Option<String>,
    pub fee: u64,
    pub units: u64,
    pub balances: Option<Balances>,
    /// verifier-v0v1: `meta.loadedAddresses` (a v0 transaction's looked-up
    /// accounts; empty for legacy and v1).
    pub loaded: fclient::vtx::LoadedAddresses,
}

impl Served {
    pub fn of(t: &TxRecord, balances: Option<&Balances>) -> Served {
        Served {
            slot: t.slot,
            block_time: t.block_time,
            tx: t.tx.clone(),
            logs: t.logs.clone(),
            err: t.err.clone(),
            fee: t.fee,
            units: t.units,
            balances: balances.cloned(),
            loaded: t.loaded.clone(),
        }
    }
}

/// What one RPC served for the cross-check. For the primary only `url`,
/// `genesis`, `finalized_slot`, `blocks` and `program_accounts` are read
/// (its transactions, balances and finals are the input's own).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceRead {
    pub url: String,
    pub genesis: Option<String>,
    pub finalized_slot: Option<u64>,
    /// The program's finalized signatures, newest first: (signature, slot,
    /// failed). `None`: not read.
    pub signatures: Option<Vec<(String, u64, bool)>>,
    /// By signature; `None`: not served.
    pub txs: BTreeMap<String, Option<Served>>,
    /// By slot; `None`: not served.
    pub blocks: BTreeMap<u64, Option<Block>>,
    /// The season's program accounts (base58). `None`: not read.
    pub program_accounts: Option<Vec<String>>,
    /// The final states read (only keys read are present).
    pub finals: BTreeMap<Key, Option<Account>>,
    pub finals_slot: u64,
    pub program_hash: Option<[u8; 32]>,
    /// The upgrade authority: `Some("none")` when the ProgramData names
    /// none, `None` when not read.
    pub upgrade_authority: Option<String>,
    /// What could not be read, each said.
    pub errors: Vec<String>,
    /// verifier-alt-archive (7.): the lookup tables the archive's v0
    /// transactions name, as this source reads them (`None`: not read).
    pub lookup_tables: Option<crate::input::LookupTables>,
    /// The lookup table snapshots' create / extend transactions as this
    /// source serves them (by signature; `None`: not served).
    pub table_txs: BTreeMap<String, Option<Served>>,
}

/// What VS asks a witness about lookup tables (verifier-alt-archive): the
/// tables the archive's v0 transactions name and the signatures of the
/// snapshots' create / extend transactions of those tables.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TableAsk {
    pub keys: Vec<Address>,
    pub sigs: Vec<fclient::ports::Signature>,
}

impl TableAsk {
    pub fn of(txs: &[TxRecord], snaps: &[fclient::alt::Snapshot]) -> TableAsk {
        let keys = crate::input::lookup_table_keys(txs);
        let mut sigs = vec![];
        for s in snaps.iter().filter(|s| keys.contains(&s.table)) {
            for r in s.history.iter().flatten() {
                if !sigs.contains(&r.signature) {
                    sigs.push(r.signature);
                }
            }
        }
        TableAsk { keys, sigs }
    }
}

fn served_json(t: &Served) -> Value {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut o = json!({
    "slot": t.slot, "block_time": t.block_time, "tx": b64.encode(&t.tx), "logs": t.logs,
    "err": t.err, "fee": t.fee, "units": t.units, "balances": bal_json(&t.balances)});
    // (verifier-v0v1: only a v0 transaction with lookups has it; others stay byte-identical)
    if !t.loaded.writable.is_empty() || !t.loaded.readonly.is_empty() {
        o["loaded"] = fclient::vtx::loaded_json(&t.loaded);
    }
    o
}

fn served_from(s: &Value) -> Result<Served, String> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let e = |m: &str| format!("witness {m}");
    let str_of = |x: &Value| x.as_str().map(String::from);
    Ok(Served {
        slot: s
            .get("slot")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| e("slot"))?,
        block_time: s.get("block_time").and_then(|x| x.as_i64()).unwrap_or(0),
        tx: b64
            .decode(
                s.get("tx")
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| e("tx"))?,
            )
            .map_err(|x| e(&x.to_string()))?,
        logs: s
            .get("logs")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(str_of).collect())
            .unwrap_or_default(),
        err: s.get("err").and_then(str_of),
        fee: s.get("fee").and_then(|x| x.as_u64()).unwrap_or(0),
        units: s.get("units").and_then(|x| x.as_u64()).unwrap_or(0),
        balances: bal_from(s.get("balances").unwrap_or(&Value::Null))?,
        loaded: fclient::vtx::loaded_from_meta(
            &json!({"loadedAddresses": s.get("loaded").cloned().unwrap_or(Value::Null)}),
        )
        .map_err(|x| e(&x))?,
    })
}

/// The primary's extra reads and the witnesses' (`Input::chain.cross`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CrossCheck {
    pub primary: SourceRead,
    pub witnesses: Vec<SourceRead>,
}

fn bal_json(b: &Option<Balances>) -> Value {
    b.as_ref().map_or(Value::Null, |b| json!([b.pre, b.post]))
}

fn bal_from(v: &Value) -> Result<Option<Balances>, String> {
    if v.is_null() {
        return Ok(None);
    }
    let nums = |x: Option<&Value>| -> Result<Vec<u64>, String> {
        x.and_then(|a| a.as_array())
            .ok_or("witness balances")?
            .iter()
            .map(|n| n.as_u64().ok_or_else(|| "witness balances".to_string()))
            .collect()
    };
    Ok(Some(Balances {
        pre: nums(v.get(0))?,
        post: nums(v.get(1))?,
    }))
}

impl SourceRead {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "url": self.url,
            "genesis": self.genesis,
            "finalized_slot": self.finalized_slot,
            "signatures": self.signatures.as_ref().map(|s| s.iter().map(|(g, sl, f)| json!([g, sl, f])).collect::<Vec<_>>()),
            "txs": self.txs.iter().map(|(s, t)| json!([s, t.as_ref().map(served_json)])).collect::<Vec<_>>(),
            "blocks": self.blocks.iter().map(|(s, b)| json!([s, b.as_ref().map(|b| json!({
                "blockhash": b.blockhash, "previous": b.previous, "parent_slot": b.parent_slot,
                "height": b.height, "signatures": b.signatures}))])).collect::<Vec<_>>(),
            "program_accounts": self.program_accounts,
            "finals": self.finals.iter().map(|(k, a)| json!([b58(k), a.as_ref().map(account_json)])).collect::<Vec<_>>(),
            "finals_slot": self.finals_slot,
            "program_hash": self.program_hash.map(hex::encode),
            "upgrade_authority": self.upgrade_authority,
            "errors": self.errors,
        });
        // (verifier-alt-archive: only when read; earlier cross-checks stay byte-identical)
        if let Some(t) = &self.lookup_tables {
            v["lookup_tables"] = t.to_json();
        }
        if !self.table_txs.is_empty() {
            v["table_txs"] = Value::Array(
                self.table_txs
                    .iter()
                    .map(|(s, t)| json!([s, t.as_ref().map(served_json)]))
                    .collect(),
            );
        }
        v
    }

    pub fn from_json(v: &Value) -> Result<SourceRead, String> {
        let e = |m: &str| format!("witness {m}");
        let arr = |k: &str| v.get(k).and_then(|x| x.as_array()).cloned();
        let str_of = |x: &Value| x.as_str().map(String::from);
        let mut txs = BTreeMap::new();
        for t in arr("txs").unwrap_or_default() {
            let sig = t.get(0).and_then(str_of).ok_or_else(|| e("txs"))?;
            let served = match t.get(1) {
                None | Some(Value::Null) => None,
                Some(s) => Some(served_from(s)?),
            };
            txs.insert(sig, served);
        }
        let mut blocks = BTreeMap::new();
        for b in arr("blocks").unwrap_or_default() {
            let slot = b
                .get(0)
                .and_then(|x| x.as_u64())
                .ok_or_else(|| e("blocks"))?;
            let block = match b.get(1) {
                None | Some(Value::Null) => None,
                Some(x) => Some(Block {
                    blockhash: x.get("blockhash").and_then(str_of).unwrap_or_default(),
                    previous: x.get("previous").and_then(str_of).unwrap_or_default(),
                    parent_slot: x.get("parent_slot").and_then(|y| y.as_u64()).unwrap_or(0),
                    height: x.get("height").and_then(|y| y.as_u64()),
                    signatures: x
                        .get("signatures")
                        .and_then(|y| y.as_array())
                        .map(|a| a.iter().filter_map(str_of).collect())
                        .unwrap_or_default(),
                }),
            };
            blocks.insert(slot, block);
        }
        let mut finals = BTreeMap::new();
        for f in arr("finals").unwrap_or_default() {
            let k: Address = f
                .get(0)
                .and_then(|x| x.as_str())
                .and_then(|x| x.parse().ok())
                .ok_or_else(|| e("finals"))?;
            let a =
                parse_account(f.get(1).unwrap_or(&Value::Null)).map_err(|x| e(&x.to_string()))?;
            finals.insert(k.to_bytes(), a);
        }
        Ok(SourceRead {
            url: v.get("url").and_then(str_of).unwrap_or_default(),
            genesis: v.get("genesis").and_then(str_of),
            finalized_slot: v.get("finalized_slot").and_then(|x| x.as_u64()),
            signatures: match arr("signatures") {
                None => None,
                Some(a) => Some(
                    a.iter()
                        .map(|s| {
                            Some((
                                s.get(0)?.as_str()?.to_string(),
                                s.get(1)?.as_u64()?,
                                s.get(2)?.as_bool()?,
                            ))
                        })
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(|| e("signatures"))?,
                ),
            },
            txs,
            blocks,
            program_accounts: arr("program_accounts")
                .map(|a| a.iter().filter_map(str_of).collect()),
            finals,
            finals_slot: v.get("finals_slot").and_then(|x| x.as_u64()).unwrap_or(0),
            program_hash: match v.get("program_hash").and_then(|x| x.as_str()) {
                Some(h) => Some(crate::input::hex_arr(h)?),
                None => None,
            },
            upgrade_authority: v.get("upgrade_authority").and_then(str_of),
            errors: arr("errors")
                .map(|a| a.iter().filter_map(str_of).collect())
                .unwrap_or_default(),
            lookup_tables: match v.get("lookup_tables") {
                None | Some(Value::Null) => None,
                Some(t) => Some(crate::input::LookupTables::from_json(t)?),
            },
            table_txs: {
                let mut m = BTreeMap::new();
                for t in arr("table_txs").unwrap_or_default() {
                    let sig = t.get(0).and_then(str_of).ok_or_else(|| e("table_txs"))?;
                    let served = match t.get(1) {
                        None | Some(Value::Null) => None,
                        Some(s) => Some(served_from(s)?),
                    };
                    m.insert(sig, served);
                }
                m
            },
        })
    }
}

impl CrossCheck {
    pub fn to_json(&self) -> Value {
        json!({"primary": self.primary.to_json(),
               "witnesses": self.witnesses.iter().map(SourceRead::to_json).collect::<Vec<_>>()})
    }
    pub fn from_json(v: &Value) -> Result<CrossCheck, String> {
        Ok(CrossCheck {
            primary: SourceRead::from_json(v.get("primary").ok_or("cross.primary")?)?,
            witnesses: v
                .get("witnesses")
                .and_then(|x| x.as_array())
                .ok_or("cross.witnesses")?
                .iter()
                .map(SourceRead::from_json)
                .collect::<Result<_, _>>()?,
        })
    }
}

// ------------------------------------------------------------ the judgement

/// VS's outcome when a cross-check was asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// The witnesses' URLs.
    pub witnesses: Vec<String>,
    /// At least one witness, and no VS finding at all.
    pub agrees: bool,
    pub transactions: usize,
    pub blocks: usize,
    pub program_accounts: usize,
    pub findings: usize,
}

impl Outcome {
    pub fn json(&self) -> Value {
        json!({"sources": self.witnesses, "agrees": self.agrees, "transactions": self.transactions,
               "blocks": self.blocks, "programAccounts": self.program_accounts, "findings": self.findings,
               "residual": RESIDUAL})
    }
}

/// An endpoint's identity for the independence check: `(host, port)`,
/// lowercased, the scheme's default port filled in, `localhost` / `[::1]`
/// read as `127.0.0.1`, path, query, fragment and user info dropped.
/// `None`: not an `http(s)://` URL (compared as written).
pub fn endpoint(u: &str) -> Option<(String, u16)> {
    let l = u.trim().to_ascii_lowercase();
    let (rest, default) = if let Some(r) = l.strip_prefix("https://") {
        (r, 443)
    } else if let Some(r) = l.strip_prefix("http://") {
        (r, 80)
    } else {
        return None;
    };
    let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
    let auth = auth.rsplit('@').next().unwrap_or("");
    let (host, port) = if let Some(v6) = auth.strip_prefix('[') {
        let (h, after) = v6.split_once(']')?;
        (h.to_string(), after.strip_prefix(':'))
    } else {
        match auth.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (auth.to_string(), None),
        }
    };
    let port = match port {
        None | Some("") => default,
        Some(p) => p.parse().ok()?,
    };
    let host = host.trim_end_matches('.').to_string();
    let host = if host == "localhost" || host == "::1" {
        "127.0.0.1".to_string()
    } else {
        host
    };
    Some((host, port))
}

fn loopback(host: &str) -> bool {
    host.starts_with("127.")
}

/// Whether two RPC URLs are not two sources (verify-pr95): the same host
/// (any port, path, query or spelling: one operator), or for a loopback
/// host (the verifier's own nodes, the local tests) the same host and port.
/// Two hostnames that resolve to one machine, a witness that proxies the
/// primary, or two providers on one storage are not seen ([`RESIDUAL`]).
pub fn same_source(a: &str, b: &str) -> bool {
    match (endpoint(a), endpoint(b)) {
        (Some((ha, pa)), Some((hb, pb))) => ha == hb && (!loopback(&ha) || pa == pb),
        _ => a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/'),
    }
}

fn owned(a: &Option<Account>, program: &Key) -> bool {
    a.as_ref().is_some_and(|a| a.owner.to_bytes() == *program)
}

fn account_diff(p: &Option<Account>, w: &Option<Account>) -> Option<String> {
    match (p, w) {
        (None, None) => None,
        (Some(_), None) => Some("the primary shows it, the witness shows it absent".into()),
        (None, Some(_)) => Some("the witness shows it, the primary shows it absent".into()),
        (Some(a), Some(b)) => {
            let mut d = vec![];
            if a.owner != b.owner {
                d.push(format!("owner {} / {}", a.owner, b.owner));
            }
            if a.lamports != b.lamports {
                d.push(format!("lamports {} / {}", a.lamports, b.lamports));
            }
            if a.executable != b.executable {
                d.push("executable".into());
            }
            if a.data != b.data {
                d.push(format!(
                    "data (first at byte {})",
                    a.data
                        .iter()
                        .zip(b.data.iter())
                        .position(|(x, y)| x != y)
                        .unwrap_or(a.data.len().min(b.data.len()))
                ));
            }
            (!d.is_empty()).then(|| d.join(", "))
        }
    }
}

/// The fields of a served transaction that differ (primary / witness).
fn served_diff(p: &Served, w: &Served) -> Vec<String> {
    let mut d = vec![];
    if p.slot != w.slot {
        d.push(format!("slot {} / {}", p.slot, w.slot));
    }
    if p.block_time != w.block_time {
        d.push(format!("blockTime {} / {}", p.block_time, w.block_time));
    }
    if p.tx != w.tx {
        d.push("transaction bytes".into());
    }
    if p.err != w.err {
        d.push(format!("err {:?} / {:?}", p.err, w.err));
    }
    if p.fee != w.fee {
        d.push(format!("fee {} / {}", p.fee, w.fee));
    }
    if p.units != w.units {
        d.push(format!("computeUnitsConsumed {} / {}", p.units, w.units));
    }
    if p.logs != w.logs {
        let at = p
            .logs
            .iter()
            .zip(w.logs.iter())
            .position(|(a, b)| a != b)
            .unwrap_or(p.logs.len().min(w.logs.len()));
        d.push(format!("logMessages (first at line {at})"));
    }
    if p.balances != w.balances {
        d.push("preBalances / postBalances".into());
    }
    if p.loaded != w.loaded {
        d.push("loadedAddresses".into());
    }
    d
}

/// Judges the cross-check: VS's findings and, when one was asked for, its
/// outcome (`None`: no witness asked, nothing judged).
pub fn judge(input: &Input) -> (Vec<Finding>, Option<Outcome>) {
    let Some(cross) = input.chain.cross.as_ref() else {
        return (vec![], None);
    };
    let mut out: Vec<Finding> = vec![];
    let mut push = |code: &str, entity: String, signature: String, detail: String| {
        out.push(Finding {
            code: code.into(),
            severity: Severity::Unverifiable,
            check: CHECK,
            entity,
            bell: 0,
            signature,
            detail,
        })
    };
    let program = input.cfg.program.to_bytes();
    let p = &cross.primary;
    if cross.witnesses.is_empty() {
        push(
            WITNESS_UNAVAILABLE,
            "witness".into(),
            String::new(),
            "a cross-check was asked for, and no witness was read".into(),
        );
    }
    for e in &p.errors {
        push(
            WITNESS_UNAVAILABLE,
            "primary".into(),
            String::new(),
            format!("the primary RPC ({}): {e}", p.url),
        );
    }
    // verify-pr103: the archive's order is the order VG re-executes, and ⑰
    // Q-P2 turns VG's FAIL over agreeing witnesses into the verdict FAIL;
    // an order the chain does not have (slots going back here, a
    // same-slot order its blocks do not have in 4.) is the primary's word
    // that no witness confirms.
    for (i, t) in input.txs.iter().enumerate().skip(1) {
        let before = input.txs[i - 1].slot;
        if t.slot < before {
            push(
                WITNESS_MISMATCH,
                format!("tx#{i}"),
                t.signature.to_string(),
                format!(
                    "the primary's history puts it (slot {}) after a transaction of slot {before}: not the chain's order, which no witness serves",
                    t.slot
                ),
            );
        }
    }
    let slots: BTreeSet<u64> = input.txs.iter().map(|t| t.slot).collect();
    let last_slot = input.txs.iter().map(|t| t.slot).max().unwrap_or(0);
    let mut blocks_checked = 0;
    let mut accounts_checked = 0;
    for (wi, w) in cross.witnesses.iter().enumerate() {
        let who = format!("witness {}", w.url);
        if same_source(&w.url, &p.url) {
            push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                format!(
                    "the witness is the primary RPC's own endpoint ({}): not a second source",
                    p.url
                ),
            );
        }
        if let Some(o) = cross.witnesses[..wi]
            .iter()
            .find(|o| same_source(&o.url, &w.url))
        {
            push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                format!(
                    "the same endpoint as witness {}: given twice, not another source",
                    o.url
                ),
            );
        }
        for e in &w.errors {
            push(WITNESS_UNAVAILABLE, who.clone(), String::new(), e.clone());
        }
        if w.signatures.is_none() && w.txs.is_empty() && w.blocks.is_empty() {
            push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                "the witness served nothing of the season (unreachable?)".into(),
            );
            continue;
        }
        // 1. the cluster
        match (&p.genesis, &w.genesis) {
            (Some(a), Some(b)) if a != b => push(
                WITNESS_MISMATCH,
                who.clone(),
                String::new(),
                format!("another cluster: genesis hash {a} on the primary, {b} on the witness"),
            ),
            (Some(_), Some(_)) => {}
            _ => push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                "the genesis hash of a source was not read: the same cluster is not shown".into(),
            ),
        }
        if w.finalized_slot
            .is_none_or(|s| s < last_slot.max(input.final_slot))
        {
            push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                format!(
                    "the witness's finalized slot {:?} is behind the season read (last transaction slot {last_slot}, final states at slot {})",
                    w.finalized_slot, input.final_slot
                ),
            );
        }
        // 2. the signature list
        let cutoff = input.final_slot.max(w.finals_slot);
        let mut listed: BTreeMap<&str, (u64, bool)> = BTreeMap::new();
        match &w.signatures {
            None => push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                "the witness's signature list of the program was not read".into(),
            ),
            Some(l) => {
                for (s, slot, failed) in l {
                    if listed.insert(s.as_str(), (*slot, *failed)).is_some() {
                        push(
                            WITNESS_UNAVAILABLE,
                            who.clone(),
                            s.clone(),
                            "the witness lists this signature twice".into(),
                        );
                    }
                }
            }
        }
        let archived: BTreeSet<String> =
            input.txs.iter().map(|t| t.signature.to_string()).collect();
        if w.signatures.is_some() {
            for (s, (slot, failed)) in &listed {
                if *slot <= cutoff && !archived.contains(*s) {
                    push(
                        WITNESS_MISSING_TX,
                        who.clone(),
                        s.to_string(),
                        format!(
                            "the witness lists this {}program transaction at finalized slot {slot}; the primary's history does not hold it",
                            if *failed { "failed " } else { "" }
                        ),
                    );
                }
            }
        }
        // 3. each archived transaction
        for (i, t) in input.txs.iter().enumerate() {
            let s = t.signature.to_string();
            let mine = Served::of(t, input.chain.of(t));
            if w.signatures.is_some() {
                match listed.get(s.as_str()) {
                    None => push(
                        WITNESS_UNKNOWN_TX,
                        format!("tx#{i}"),
                        s.clone(),
                        format!("the primary's history holds it (slot {}); the witness does not list it among the program's finalized transactions ({who})", t.slot),
                    ),
                    Some((slot, failed)) if *slot != t.slot || *failed != t.err.is_some() => push(
                        WITNESS_MISMATCH,
                        format!("tx#{i}"),
                        s.clone(),
                        format!("listed at slot {slot} (failed {failed}) by the witness, at slot {} (failed {}) by the primary ({who})", t.slot, t.err.is_some()),
                    ),
                    Some(_) => {}
                }
            }
            match w.txs.get(&s) {
                None | Some(None) => {
                    if listed.contains_key(s.as_str()) {
                        push(
                            WITNESS_UNAVAILABLE,
                            format!("tx#{i}"),
                            s.clone(),
                            format!(
                                "the witness lists it but did not serve it at finalized ({who})"
                            ),
                        );
                    } else if w.signatures.is_none() {
                        push(
                            WITNESS_UNKNOWN_TX,
                            format!("tx#{i}"),
                            s.clone(),
                            format!("the witness did not serve it at finalized ({who})"),
                        );
                    }
                }
                Some(Some(theirs)) => {
                    let d = served_diff(&mine, theirs);
                    if !d.is_empty() {
                        push(
                            WITNESS_MISMATCH,
                            format!("tx#{i}"),
                            s.clone(),
                            format!("primary / witness differ: {} ({who})", d.join("; ")),
                        );
                    }
                }
            }
        }
        // 4. the blocks of the archive's slots
        for &slot in &slots {
            let at: Vec<String> = input
                .txs
                .iter()
                .filter(|t| t.slot == slot)
                .map(|t| t.signature.to_string())
                .collect();
            let pb = p.blocks.get(&slot).cloned().flatten();
            let wb = w.blocks.get(&slot).cloned().flatten();
            let (Some(pb), Some(wb)) = (pb, wb) else {
                push(
                    WITNESS_UNAVAILABLE,
                    format!("block {slot}"),
                    String::new(),
                    format!(
                        "the block of slot {slot} was not served by the {} ({who})",
                        match (p.blocks.get(&slot), w.blocks.get(&slot)) {
                            (Some(Some(_)), _) => "witness",
                            (_, Some(Some(_))) => "primary",
                            _ => "primary nor the witness",
                        }
                    ),
                );
                continue;
            };
            blocks_checked += 1;
            let mut d = vec![];
            if pb.blockhash != wb.blockhash {
                d.push(format!("blockhash {} / {}", pb.blockhash, wb.blockhash));
            }
            if pb.previous != wb.previous {
                d.push(format!(
                    "previousBlockhash {} / {}",
                    pb.previous, wb.previous
                ));
            }
            if pb.parent_slot != wb.parent_slot {
                d.push(format!(
                    "parentSlot {} / {}",
                    pb.parent_slot, wb.parent_slot
                ));
            }
            if pb.height != wb.height {
                d.push(format!("blockHeight {:?} / {:?}", pb.height, wb.height));
            }
            if wb.parent_slot >= slot && slot > 0 {
                d.push(format!(
                    "the witness's parent slot {} is not before it",
                    wb.parent_slot
                ));
            }
            // The archive's order inside the slot is each block's (the
            // block lists its transactions in execution order).
            for (side, blk) in [("primary's own", &pb), ("witness's", &wb)] {
                let pos: Vec<usize> = at
                    .iter()
                    .filter_map(|s| blk.signatures.iter().position(|x| x == s))
                    .collect();
                if pos.windows(2).any(|w| w[0] > w[1]) {
                    d.push(format!(
                        "the primary's history orders the slot's transactions otherwise than the {side} block"
                    ));
                }
            }
            for s in &at {
                if !pb.signatures.contains(s) {
                    d.push(format!("{s} is not in the primary's own block"));
                }
                if !wb.signatures.contains(s) {
                    d.push(format!("{s} is not in the witness's block"));
                }
            }
            if !d.is_empty() {
                push(
                    WITNESS_MISMATCH,
                    format!("block {slot}"),
                    String::new(),
                    format!("primary / witness: {} ({who})", d.join("; ")),
                );
            }
        }
        // 5. the program's accounts and their final states
        match (&p.program_accounts, &w.program_accounts) {
            (Some(a), Some(b)) => {
                let a: BTreeSet<&String> = a.iter().collect();
                let b: BTreeSet<&String> = b.iter().collect();
                for k in a.symmetric_difference(&b) {
                    push(
                        WITNESS_MISMATCH,
                        format!("account {k}"),
                        String::new(),
                        format!(
                            "a program account of the season on the {} only ({who})",
                            if a.contains(k) { "primary" } else { "witness" }
                        ),
                    );
                }
            }
            _ => push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                "the season's program accounts (getProgramAccounts) were not read from both sources".into(),
            ),
        }
        let mut keys: BTreeSet<Key> = input.finals.keys().copied().collect();
        keys.extend(
            w.program_accounts
                .iter()
                .flatten()
                .filter_map(|k| k.parse::<Address>().ok())
                .map(|a| a.to_bytes()),
        );
        for k in keys {
            let pf = input.finals.get(&k).cloned().flatten();
            let Some(wf) = w.finals.get(&k) else {
                if owned(&pf, &program) || !input.finals.contains_key(&k) {
                    push(
                        WITNESS_UNAVAILABLE,
                        format!("account {}", b58(&k)),
                        String::new(),
                        format!(
                            "its final state was not read from the {} ({who})",
                            if input.finals.contains_key(&k) {
                                "witness"
                            } else {
                                "primary"
                            }
                        ),
                    );
                }
                continue;
            };
            if !owned(&pf, &program) && !owned(wf, &program) {
                continue;
            }
            accounts_checked += 1;
            if let Some(d) = account_diff(&pf, wf) {
                push(
                    WITNESS_MISMATCH,
                    format!("account {}", b58(&k)),
                    String::new(),
                    format!("its final state differs: {d} ({who})"),
                );
            }
        }
        // 7. lookup tables (verifier-alt-archive): the bodies (F1) and every
        //    lookup confirmed on the witness's own reads (F2)
        tables_judge(input, w, &who, &mut push);
        // 6. the deployed binary and its authority
        match (input.program_hashes.last().map(|(_, h)| *h), w.program_hash) {
            (Some(a), Some(b)) if a != b => push(
                WITNESS_MISMATCH,
                who.clone(),
                String::new(),
                format!(
                    "the deployed .so is {} on the primary, {} on the witness",
                    hex::encode(a),
                    hex::encode(b)
                ),
            ),
            (Some(_), Some(_)) => {}
            _ => push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                "the deployed .so hash was not read from both sources".into(),
            ),
        }
        let mine = input
            .chain
            .upgrade_authority
            .map_or("none".to_string(), |a| a.to_string());
        match &w.upgrade_authority {
            Some(a) if *a != mine => push(
                WITNESS_MISMATCH,
                who.clone(),
                String::new(),
                format!("the upgrade authority is {mine} on the primary, {a} on the witness"),
            ),
            Some(_) => {}
            None => push(
                WITNESS_UNAVAILABLE,
                who.clone(),
                String::new(),
                "the upgrade authority was not read from the witness".into(),
            ),
        }
    }
    if cfg!(feature = "mutate-vs") {
        // The check of the check: a VS that trusts every witness blindly.
        out.clear();
    }
    let outcome = Outcome {
        witnesses: cross.witnesses.iter().map(|w| w.url.clone()).collect(),
        agrees: !cross.witnesses.is_empty() && out.is_empty(),
        transactions: input.txs.len(),
        blocks: blocks_checked,
        program_accounts: accounts_checked,
        findings: out.len(),
    };
    (out, Some(outcome))
}

/// Item 7 (verifier-alt-archive): the lookup tables on witness `w`: F1, the
/// table bodies against the primary's read; F2, every lookup of the
/// archive's v0 transactions confirmed on the witness's own reads. Nothing
/// when the archive has no lookups (a legacy / v1 cross-check is unchanged).
fn tables_judge(
    input: &Input,
    w: &SourceRead,
    who: &str,
    push: &mut impl FnMut(&str, String, String, String),
) {
    use fclient::alt::{classify, prefix_compatible, replay, Read};
    let keys = crate::input::lookup_table_keys(&input.txs);
    if keys.is_empty() {
        return;
    }
    let Some(wt) = w.lookup_tables.as_ref() else {
        push(
            WITNESS_UNAVAILABLE,
            who.to_string(),
            String::new(),
            "the lookup tables the archive's v0 transactions name were not read from the witness"
                .into(),
        );
        return;
    };
    // F1: the bodies.
    if let Some(pt) = input.chain.lookup_tables.as_ref() {
        for k in &keys {
            let (Some(pa), Some(wa)) = (
                pt.accounts.get(&k.to_bytes()),
                wt.accounts.get(&k.to_bytes()),
            ) else {
                continue;
            };
            let later_is_witness = match (pt.slot, wt.slot) {
                (Some(p), Some(q)) => Some(q >= p),
                _ => None,
            };
            let d: Option<String> = match (classify(pa.as_ref()), classify(wa.as_ref())) {
                (Read::Table(a), Read::Table(b)) => {
                    let mut d = vec![];
                    if !prefix_compatible(&a.addresses, &b.addresses) {
                        d.push(format!(
                            "addresses differ at index {}",
                            a.addresses
                                .iter()
                                .zip(&b.addresses)
                                .position(|(x, y)| x != y)
                                .unwrap_or(0)
                        ));
                    } else if pt.slot.is_some() && pt.slot == wt.slot && a != b {
                        d.push("the state differs at one slot".into());
                    }
                    // Grows only with the later read; deactivates and freezes
                    // only forward.
                    let (early, late) = match later_is_witness {
                        Some(true) => (&a, &b),
                        Some(false) => (&b, &a),
                        None => (&a, &b),
                    };
                    if later_is_witness.is_some() && late.addresses.len() < early.addresses.len() {
                        d.push(format!(
                            "the later read holds {} addresses, the earlier {}",
                            late.addresses.len(),
                            early.addresses.len()
                        ));
                    }
                    if a.authority.is_some() && b.authority.is_some() && a.authority != b.authority
                    {
                        d.push("the authority differs".into());
                    }
                    if later_is_witness.is_some()
                        && early.authority.is_none()
                        && late.authority.is_some()
                    {
                        d.push("the authority comes back after a freeze".into());
                    }
                    if later_is_witness.is_some()
                        && early.deactivation_slot != u64::MAX
                        && late.deactivation_slot != early.deactivation_slot
                    {
                        d.push("the deactivation slot changes after deactivation".into());
                    }
                    (!d.is_empty()).then(|| d.join(", "))
                }
                (Read::Closed, Read::Closed) => None,
                // A closed table never reopens: a table read later than a
                // closed read is a lie of one source.
                (Read::Closed, Read::Table(_)) if later_is_witness != Some(false) => {
                    Some("closed on the primary, a table on the witness's later read".into())
                }
                (Read::Table(_), Read::Closed) if later_is_witness == Some(false) => {
                    Some("closed on the witness, a table on the primary's later read".into())
                }
                (Read::Closed, Read::Table(_)) | (Read::Table(_), Read::Closed) => None,
                _ => account_diff(pa, wa),
            };
            if let Some(d) = d {
                push(
                    WITNESS_MISMATCH,
                    format!("LookupTable:{k}"),
                    String::new(),
                    format!("the lookup table's state: {d} ({who})"),
                );
            }
        }
    }
    // F2: every lookup confirmed on the witness's own reads.
    let mut replays: BTreeMap<Address, Result<fclient::alt::Built, fclient::alt::Refused>> =
        BTreeMap::new();
    let mut said: BTreeSet<Address> = BTreeSet::new();
    for (i, rec) in input.txs.iter().enumerate() {
        let Ok(m) = crate::vmsg::Msg::of(rec) else {
            continue;
        };
        for (t, idx, addr, _) in m.lookups() {
            if said.contains(&t) {
                continue;
            }
            let read = wt.accounts.get(&t.to_bytes()).map(|a| classify(a.as_ref()));
            if let Some(Read::Table(tb)) = &read {
                match tb.addresses.get(idx as usize) {
                    Some(a) if *a == addr => continue,
                    Some(a) => {
                        said.insert(t);
                        push(
                            WITNESS_MISMATCH,
                            format!("LookupTable:{t}"),
                            rec.signature.to_string(),
                            format!("tx#{i}: the witness's table holds {a} at index {idx}, the archive's meta.loadedAddresses {addr} ({who})"),
                        );
                        continue;
                    }
                    None => {}
                }
            }
            // The snapshots' history of `t`, as the witness serves it.
            let built = replays.entry(t).or_insert_with(|| {
                let mut hist: Vec<TxRecord> = vec![];
                let mut sigs: BTreeSet<String> = BTreeSet::new();
                for sn in input.chain.lookup_snapshots.iter().filter(|s| s.table == t) {
                    for r in sn.history.iter().flatten() {
                        if !sigs.insert(r.signature.to_string()) {
                            continue;
                        }
                        match w.table_txs.get(&r.signature.to_string()) {
                            Some(Some(sv)) => {
                                if sv.tx != r.tx || sv.slot != r.slot || sv.err != r.err {
                                    return Err(fclient::alt::Refused::from(format!(
                                        "the witness serves its transaction {} otherwise than the archive (bytes, slot or error)",
                                        r.signature
                                    )));
                                }
                                hist.push(TxRecord {
                                    signature: r.signature,
                                    slot: sv.slot,
                                    tx: sv.tx.clone(),
                                    err: sv.err.clone(),
                                    loaded: sv.loaded.clone(),
                                    ..TxRecord::default()
                                });
                            }
                            _ => {
                                return Err(fclient::alt::Refused::from(format!(
                                    "the witness did not serve its transaction {}",
                                    r.signature
                                )))
                            }
                        }
                    }
                }
                if hist.is_empty() {
                    return Err(fclient::alt::Refused::from(
                        "no snapshot of it carries its create / extend transactions".to_string(),
                    ));
                }
                hist.sort_by_key(|r| r.slot);
                replay(&t, &hist)
            });
            match crate::lookup::history_says(
                "its transactions as the witness serves them",
                Some(built),
                idx,
                &addr,
                rec.slot,
            ) {
                crate::lookup::Settle::Same => {}
                crate::lookup::Settle::Differs { why, .. } => {
                    said.insert(t);
                    let mismatch = built.is_ok();
                    push(
                        if mismatch {
                            WITNESS_MISMATCH
                        } else {
                            WITNESS_UNAVAILABLE
                        },
                        format!("LookupTable:{t}"),
                        rec.signature.to_string(),
                        format!("tx#{i}: index {idx}: {why} ({who})"),
                    );
                }
                crate::lookup::Settle::Silent(why) => {
                    said.insert(t);
                    push(
                        WITNESS_UNAVAILABLE,
                        format!("LookupTable:{t}"),
                        rec.signature.to_string(),
                        format!(
                            "tx#{i}: the witness confirms no lookup of index {idx} in table {t}: its table read {}; {why} ({who})",
                            match read {
                                None => "is missing".to_string(),
                                Some(Read::Closed) => "shows it closed".to_string(),
                                Some(Read::Table(tb)) => format!("holds {} addresses", tb.addresses.len()),
                                Some(Read::Foreign(_)) => "is not a lookup table".to_string(),
                            }
                        ),
                    );
                }
            }
        }
    }
}

// ------------------------------------------------------------ the reads

/// How long [`read_witness`] waits for a witness's finalized slot to reach
/// the season read.
pub const BEHIND_WAITS: u32 = 120;
pub const BEHIND_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

async fn genesis(rpc: &RpcClient, errors: &mut Vec<String>) -> Option<String> {
    match rpc.call("getGenesisHash", json!([])).await {
        Ok(v) => v.as_str().map(String::from),
        Err(e) => {
            errors.push(format!("getGenesisHash: {e}"));
            None
        }
    }
}

async fn finalized_slot(rpc: &RpcClient) -> Option<u64> {
    rpc.call("getSlot", json!([{"commitment": "finalized"}]))
        .await
        .ok()?
        .as_u64()
}

/// The blocks of `slots`; a read that failed (not a block the node says it
/// lacks) is also said in `errors` (B5: a 429 used to read as "not served",
/// as if the source had lied).
async fn blocks(
    rpc: &RpcClient,
    slots: &BTreeSet<u64>,
    errors: &mut Vec<String>,
) -> BTreeMap<u64, Option<Block>> {
    let mut out = BTreeMap::new();
    for &s in slots {
        let v = match rpc
            .call(
                "getBlock",
                json!([s, {"encoding": "json", "transactionDetails": "signatures", "rewards": false,
                        "commitment": "finalized",
                        "maxSupportedTransactionVersion": fclient::rpc::MAX_TX_VERSION}]),
            )
            .await
        {
            Ok(v) => Some(v).filter(|v| !v.is_null()),
            Err(e) => {
                errors.push(format!("getBlock {s}: {e}"));
                None
            }
        };
        let b = v.map(|v| Block {
            blockhash: v["blockhash"].as_str().unwrap_or_default().into(),
            previous: v["previousBlockhash"].as_str().unwrap_or_default().into(),
            parent_slot: v["parentSlot"].as_u64().unwrap_or(0),
            height: v["blockHeight"].as_u64(),
            signatures: v["signatures"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
        });
        out.insert(s, b);
    }
    out
}

async fn program_accounts(
    url: &str,
    program: &Address,
    season_id: u64,
    errors: &mut Vec<String>,
) -> Option<Vec<String>> {
    match crate::input::program_accounts(url, program, season_id).await {
        Ok(v) => Some(v.iter().map(|k| k.to_string()).collect()),
        Err(e) => {
            errors.push(format!("getProgramAccounts: {e}"));
            None
        }
    }
}

/// The primary's extra reads: its cluster, finalized slot, the blocks of
/// the archive's slots and the season's program accounts.
pub async fn read_primary(
    url: &str,
    program: &Address,
    season_id: u64,
    txs: &[TxRecord],
) -> SourceRead {
    let rpc = crate::input::rpc_client(url);
    let mut errors = vec![];
    let slots: BTreeSet<u64> = txs.iter().map(|t| t.slot).collect();
    let genesis = genesis(&rpc, &mut errors).await;
    let finalized_slot = finalized_slot(&rpc).await;
    let blocks = blocks(&rpc, &slots, &mut errors).await;
    SourceRead {
        url: url.into(),
        genesis,
        finalized_slot,
        blocks,
        program_accounts: program_accounts(url, program, season_id, &mut errors).await,
        errors,
        ..SourceRead::default()
    }
}

/// Everything VS compares, read from one witness: it waits (bounded) for
/// the witness's finalized slot to reach `final_slot`, then reads the
/// final states (the primary's keys and the witness's own program
/// accounts) and, after them, the program's whole signature list, each
/// listed or archived transaction, the archive's blocks and the binary.
/// Nothing fails: what is not read is said in `errors` (UNVERIFIABLE).
#[allow(clippy::too_many_arguments)]
pub async fn read_witness(
    url: &str,
    program: &Address,
    season_id: u64,
    txs: &[TxRecord],
    final_keys: &[Address],
    final_slot: u64,
    tables: &TableAsk,
) -> SourceRead {
    let rpc = crate::input::rpc_client(url);
    let mut r = SourceRead {
        url: url.into(),
        ..SourceRead::default()
    };
    r.genesis = genesis(&rpc, &mut r.errors).await;
    if r.genesis.is_none() {
        // Unreachable (or not an RPC): nothing else is read.
        return r;
    }
    let want = final_slot.max(txs.iter().map(|t| t.slot).max().unwrap_or(0));
    let mut waits = 0;
    loop {
        r.finalized_slot = finalized_slot(&rpc).await;
        if r.finalized_slot.is_some_and(|s| s >= want) || waits >= BEHIND_WAITS {
            break;
        }
        waits += 1;
        tokio::time::sleep(BEHIND_WAIT).await;
    }
    r.program_accounts = program_accounts(url, program, season_id, &mut r.errors).await;
    let mut keys: Vec<Address> = final_keys.to_vec();
    for k in r.program_accounts.iter().flatten() {
        if let Ok(a) = k.parse::<Address>() {
            if !keys.contains(&a) {
                keys.push(a);
            }
        }
    }
    match crate::input::fetch_finals(url, &keys).await {
        Ok((m, slot)) => {
            r.finals = m;
            r.finals_slot = slot;
        }
        Err(e) => r.errors.push(format!("the final states: {e}")),
    }
    // The whole list, paged to its end (read after the finals: a
    // transaction landing in between is listed, and is then missing from
    // the primary's archive or explains a final that moved).
    let mut list: Vec<(String, u64, bool)> = vec![];
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut before: Option<fclient::ports::Signature> = None;
    let complete = loop {
        match rpc
            .get_finalized_signatures_for_address(program, before.as_ref(), None, 1_000)
            .await
        {
            Err(e) => {
                r.errors.push(format!(
                    "getSignaturesForAddress (page after {before:?}): {e}"
                ));
                break false;
            }
            Ok(page) => {
                let n = page.len();
                let mut again = false;
                for s in &page {
                    let k = s.signature.to_string();
                    if !seen.insert(k.clone()) {
                        again = true;
                        break;
                    }
                    list.push((k, s.slot, s.failed));
                }
                if again {
                    r.errors.push(
                        "getSignaturesForAddress served a signature twice (`before` ignored?): the list is not whole"
                            .into(),
                    );
                    break false;
                }
                if n < 1_000 {
                    break true;
                }
                before = page.last().map(|s| s.signature);
            }
        }
    };
    if complete {
        r.signatures = Some(list.clone());
    }
    let mut want_txs: Vec<fclient::ports::Signature> = txs.iter().map(|t| t.signature).collect();
    for (s, _, _) in &list {
        if let Ok(sig) = s.parse::<fclient::ports::Signature>() {
            if !want_txs.contains(&sig) {
                want_txs.push(sig);
            }
        }
    }
    for sig in want_txs {
        let v = rpc
            .call(
                "getTransaction",
                json!([sig.to_string(), {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": fclient::rpc::MAX_TX_VERSION}]),
            )
            .await;
        let served = match v {
            Ok(v) if v.is_null() => None,
            Ok(v) => match fclient::rpc::parse_transaction(&sig, &v) {
                Ok(t) => {
                    let balances =
                        fclient::rpc::parse_balances(&v).map(|(pre, post)| Balances { pre, post });
                    Some(Served::of(&t, balances.as_ref()))
                }
                Err(e) => {
                    r.errors.push(format!("getTransaction {sig}: {e}"));
                    None
                }
            },
            Err(e) => {
                r.errors.push(format!("getTransaction {sig}: {e}"));
                None
            }
        };
        r.txs.insert(sig.to_string(), served);
    }
    let slots: BTreeSet<u64> = txs.iter().map(|t| t.slot).collect();
    r.blocks = blocks(&rpc, &slots, &mut r.errors).await;
    // 7. the lookup tables and the snapshots' table transactions
    if !tables.keys.is_empty() {
        match crate::input::fetch_lookup_tables(url, &tables.keys, final_slot).await {
            Ok(t) => r.lookup_tables = Some(t),
            Err(e) => r.errors.push(format!("the lookup tables: {e}")),
        }
    }
    for sig in &tables.sigs {
        let served = match rpc.get_finalized_transaction(sig).await {
            Ok(t) => t.map(|t| Served::of(&t, None)),
            Err(e) => {
                r.errors
                    .push(format!("getTransaction {sig} (a lookup table's): {e}"));
                None
            }
        };
        r.table_txs.insert(sig.to_string(), served);
    }
    match crate::input::program_hash(url, program).await {
        Ok((_, h)) => r.program_hash = Some(h),
        Err(e) => r.errors.push(format!("the deployed .so hash: {e}")),
    }
    match crate::input::upgrade_authority(url, program).await {
        Ok(a) => r.upgrade_authority = Some(a.map_or("none".into(), |a| a.to_string())),
        Err(e) => r.errors.push(format!("the upgrade authority: {e}")),
    }
    r
}

/// The cross-check of `txs` (and the finals read at `final_slot`) against
/// every witness.
#[allow(clippy::too_many_arguments)]
pub async fn cross_check(
    primary: &str,
    witnesses: &[String],
    program: &Address,
    season_id: u64,
    txs: &[TxRecord],
    final_keys: &[Address],
    final_slot: u64,
    tables: &TableAsk,
) -> CrossCheck {
    let mut c = CrossCheck {
        primary: read_primary(primary, program, season_id, txs).await,
        witnesses: vec![],
    };
    for w in witnesses {
        c.witnesses
            .push(read_witness(w, program, season_id, txs, final_keys, final_slot, tables).await);
    }
    c
}

/// The cross-check a witness would give if it served exactly what the
/// input holds (tests: an honest second source of a recorded season; the
/// blocks are synthetic, one per slot).
pub fn mirror(input: &Input, url: &str) -> CrossCheck {
    let slots: BTreeSet<u64> = input.txs.iter().map(|t| t.slot).collect();
    let mut blocks = BTreeMap::new();
    let mut prev = (0u64, "genesis".to_string());
    for s in slots {
        let h = hex::encode(permutation_rules::hash::sha256(&[
            b"block".as_slice(),
            &s.to_le_bytes(),
        ]));
        blocks.insert(
            s,
            Some(Block {
                blockhash: h.clone(),
                previous: prev.1.clone(),
                parent_slot: prev.0,
                height: Some(s),
                signatures: input
                    .txs
                    .iter()
                    .filter(|t| t.slot == s)
                    .map(|t| t.signature.to_string())
                    .collect(),
            }),
        );
        prev = (s, h);
    }
    let program = input.cfg.program.to_bytes();
    let accounts: Vec<String> = input
        .finals
        .iter()
        .filter(|(_, a)| owned(a, &program))
        .map(|(k, _)| b58(k))
        .collect();
    let primary = SourceRead {
        url: "primary".into(),
        genesis: Some("genesis".into()),
        finalized_slot: Some(input.final_slot),
        blocks: blocks.clone(),
        program_accounts: Some(accounts.clone()),
        ..SourceRead::default()
    };
    let witness = SourceRead {
        url: url.into(),
        genesis: Some("genesis".into()),
        finalized_slot: Some(
            input
                .final_slot
                .max(input.txs.iter().map(|t| t.slot).max().unwrap_or(0)),
        ),
        signatures: Some(
            input
                .txs
                .iter()
                .rev()
                .map(|t| (t.signature.to_string(), t.slot, t.err.is_some()))
                .collect(),
        ),
        txs: input
            .txs
            .iter()
            .map(|t| {
                (
                    t.signature.to_string(),
                    Some(Served::of(t, input.chain.of(t))),
                )
            })
            .collect(),
        blocks,
        program_accounts: Some(accounts),
        finals: input.finals.clone(),
        finals_slot: input.final_slot,
        program_hash: input.program_hashes.last().map(|(_, h)| *h),
        upgrade_authority: Some(
            input
                .chain
                .upgrade_authority
                .map_or("none".into(), |a| a.to_string()),
        ),
        errors: vec![],
        // (verifier-alt-archive: an honest witness reads the same tables and
        //  serves the snapshots' table transactions as archived)
        lookup_tables: if crate::input::lookup_table_keys(&input.txs).is_empty() {
            None
        } else {
            input.chain.lookup_tables.clone()
        },
        table_txs: {
            let ask = TableAsk::of(&input.txs, &input.chain.lookup_snapshots);
            let mut m = BTreeMap::new();
            for sn in &input.chain.lookup_snapshots {
                for r in sn.history.iter().flatten() {
                    if ask.sigs.contains(&r.signature) {
                        m.insert(r.signature.to_string(), Some(Served::of(r, None)));
                    }
                }
            }
            m
        },
    };
    CrossCheck {
        primary,
        witnesses: vec![witness],
    }
}
