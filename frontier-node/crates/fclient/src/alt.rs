//! Address lookup tables as evidence (verifier-alt-archive, follow-up F2 of
//! verify-pr155): a table's account bytes, its own create / extend
//! transactions, and the **snapshot** findex archives the first time a
//! season transaction uses a table, so the verifier's VT can still check a
//! v0 transaction's `meta.loadedAddresses` after the table was closed.
//!
//! A lookup table (`AddressLookupTab1e1111111111111111111111111`) is
//! append-only: `ExtendLookupTable` appends, nothing rewrites an index;
//! `CreateLookupTable` derives the address from (authority, a slot that must
//! be in SlotHashes, bump), so once closed (which needs the deactivation
//! slot to have left SlotHashes) it can never be created again. Hence
//! **every** state of the table that holds index `i` holds the address `i`
//! held when any transaction used it (solana-program/address-lookup-table
//! `processor.rs`; solana-address-lookup-table-interface `state.rs`).
//!
//! Two kinds of evidence for a table's addresses, each checked here:
//! - [`decode_table`]: the account's bytes as an RPC served them at a slot
//!   (`getMultipleAccounts` with its `context.slot`);
//! - [`replay`]: the table's own transactions (`getSignaturesForAddress`
//!   of the table, then `getTransaction`), signature-checked and replayed
//!   by the lookup-table program's rules from the `CreateLookupTable`
//!   (whose PDA derivation must give the table's address). Any successful
//!   transaction that writes the table without being explained by its
//!   top-level lookup-table instructions alone (another program's
//!   instruction could have extended it by CPI; inner instructions are not
//!   archived) makes the replay refuse, never guess.

use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;

use crate::ports::{Account, PortError, PortResult, Signature, TxRecord};
use crate::rpc::{account_json, parse_account, RpcClient};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The address lookup table program (a builtin / core BPF program of every
/// cluster).
pub fn program() -> Address {
    "AddressLookupTab1e1111111111111111111111111"
        .parse()
        .expect("the lookup table program id")
}

fn compute_budget() -> Address {
    "ComputeBudget111111111111111111111111111111"
        .parse()
        .expect("the compute budget program id")
}

/// `LookupTableMeta` (discriminator u32, deactivation slot u64, last
/// extended slot u64, its start index u8, `Option<authority>`, padding u16).
pub const META: usize = 56;

/// A lookup table account, decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableState {
    /// `u64::MAX` while active.
    pub deactivation_slot: u64,
    pub last_extended_slot: u64,
    pub last_extended_start: u8,
    /// `None`: frozen.
    pub authority: Option<Address>,
    pub addresses: Vec<Address>,
}

/// A lookup table account's state (`None`: not a lookup table: another
/// owner, an uninitialized or malformed one).
pub fn decode_table(owner: &Address, data: &[u8]) -> Option<TableState> {
    if *owner != program()
        || data.len() < META
        || !(data.len() - META).is_multiple_of(32)
        || data[..4] != 1u32.to_le_bytes()
    {
        return None;
    }
    let u64_at = |o: usize| u64::from_le_bytes(data[o..o + 8].try_into().expect("8"));
    // (Only the tag, owner and length decide "a table", exactly as the
    // verifier's VT always read it; an option byte other than 1 reads as
    // no authority.)
    let authority =
        (data[21] == 1).then(|| Address::new_from_array(data[22..54].try_into().expect("32")));
    Some(TableState {
        deactivation_slot: u64_at(4),
        last_extended_slot: u64_at(12),
        last_extended_start: data[20],
        authority,
        addresses: data[META..]
            .chunks(32)
            .map(|c| Address::new_from_array(c.try_into().expect("32")))
            .collect(),
    })
}

/// What an account read at a table's address says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Read<'a> {
    /// A lookup table.
    Table(TableState),
    /// Closed: absent, or only lamports sent to its address since (a
    /// System transfer to the PDA: System owner, no data). verify-pr155.
    Closed,
    /// Anything else (another owner with data): no honest read of a table
    /// address shows it.
    Foreign(&'a Account),
}

/// Classifies an account read at a table address.
pub fn classify(a: Option<&Account>) -> Read<'_> {
    let system = crate::addr::system_program();
    match a {
        None => Read::Closed,
        Some(a) if a.lamports == 0 && a.data.is_empty() => Read::Closed,
        Some(a) if a.data.is_empty() && a.owner == system => Read::Closed,
        Some(a) => match decode_table(&a.owner, &a.data) {
            Some(t) => Read::Table(t),
            None => Read::Foreign(a),
        },
    }
}

/// Whether one list is a prefix of the other (two reads of one
/// append-only table always are).
pub fn prefix_compatible(a: &[Address], b: &[Address]) -> bool {
    let n = a.len().min(b.len());
    a[..n] == b[..n]
}

// ------------------------------------------------------------ replay

/// A lookup table as its own transactions built it ([`replay`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Built {
    /// `None`: frozen.
    pub authority: Option<Address>,
    /// Each address with the slot of the transaction that appended it.
    pub addresses: Vec<(Address, u64)>,
    pub created_slot: u64,
    pub deactivated_slot: Option<u64>,
    pub closed_slot: Option<u64>,
    /// The table's transactions replayed (successful ones).
    pub txs: usize,
}

impl Built {
    pub fn list(&self) -> Vec<Address> {
        self.addresses.iter().map(|(a, _)| *a).collect()
    }
}

/// Why [`replay`] refused a history.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refused {
    /// The records themselves are not genuine transactions (a wire that
    /// does not decode, a first signature that is not the record's, a
    /// signature that does not verify): no honest RPC serves them. Every
    /// other refusal (out of order, a CPI possible, no Create, an
    /// instruction the program would refuse) can be an honest history
    /// served short or one this replay does not model.
    pub forged: bool,
    pub why: String,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.why)
    }
}

impl From<String> for Refused {
    fn from(why: String) -> Refused {
        Refused { forged: false, why }
    }
}

/// The lookup table program's instruction (bincode, u32 tag).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ix {
    Create { recent_slot: u64, bump: u8 },
    Freeze,
    Extend(Vec<Address>),
    Deactivate,
    Close,
}

/// Decodes an instruction's data (`None`: not one of the five, or not
/// exactly its length).
pub fn decode_ix(d: &[u8]) -> Option<Ix> {
    let tag = u32::from_le_bytes(d.get(..4)?.try_into().ok()?);
    let rest = &d[4..];
    match tag {
        0 if rest.len() == 9 => Some(Ix::Create {
            recent_slot: u64::from_le_bytes(rest[..8].try_into().ok()?),
            bump: rest[8],
        }),
        1 if rest.is_empty() => Some(Ix::Freeze),
        2 => {
            let n = u64::from_le_bytes(rest.get(..8)?.try_into().ok()?) as usize;
            let body = &rest[8..];
            if body.len() != n.checked_mul(32)? {
                return None;
            }
            Some(Ix::Extend(
                body.chunks(32)
                    .map(|c| Address::new_from_array(c.try_into().expect("32")))
                    .collect(),
            ))
        }
        3 if rest.is_empty() => Some(Ix::Deactivate),
        4 if rest.is_empty() => Some(Ix::Close),
        _ => None,
    }
}

/// Replays `table`'s own transactions (`history`, oldest first, as the
/// ledger ordered them; failed ones are skipped: they change nothing) by
/// the lookup table program's rules. Refuses (an error saying why) instead
/// of guessing whenever the history does not show the table's content
/// exactly:
/// - a record whose wire does not decode, whose first signature is not its
///   signature, or whose signatures do not verify;
/// - records out of slot order;
/// - a successful transaction that names the table writable while holding
///   any instruction other than the lookup table program's and the
///   compute budget's (a CPI could have changed the table unseen);
/// - an instruction the program would have refused (no Create first, a
///   Create whose PDA derivation is not the table, an Extend / Freeze /
///   Deactivate / Close not signed by the authority, an Extend after
///   deactivation or freeze, anything after Close);
/// - no successful `CreateLookupTable` at all.
pub fn replay(table: &Address, history: &[TxRecord]) -> Result<Built, Refused> {
    let prog = program();
    let budget = compute_budget();
    let mut b: Option<Built> = None;
    let mut last_slot = 0u64;
    for r in history {
        if r.slot < last_slot {
            return Err(format!(
                "its transaction {} (slot {}) comes after slot {last_slot}: not in ledger order",
                r.signature, r.slot
            )
            .into());
        }
        last_slot = r.slot;
        let forged = |why: String| Refused { forged: true, why };
        let d = crate::vtx::decode(&r.tx).map_err(|e| {
            forged(format!(
                "its transaction {} does not decode: {e}",
                r.signature
            ))
        })?;
        if d.signature() != r.signature {
            return Err(forged(format!(
                "its transaction {}: the wire's first signature is {}",
                r.signature,
                d.signature()
            )));
        }
        if !d.tx.verify_with_results().iter().all(|ok| *ok) {
            return Err(forged(format!(
                "its transaction {}: a signature does not verify",
                r.signature
            )));
        }
        if r.err.is_some() {
            continue;
        }
        let keys = d
            .keys(&r.loaded)
            .map_err(|e| format!("its transaction {}: {e}", r.signature))?;
        let writes_table =
            (0..keys.len()).any(|i| keys[i] == *table && d.is_writable_index(i, &r.loaded));
        let ixs = d
            .instructions_resolved(&r.loaded)
            .map_err(|e| format!("its transaction {}: {e}", r.signature))?;
        let mine = ixs
            .iter()
            .any(|(p, a, _)| *p == prog && a.first() == Some(table));
        if !writes_table && !mine {
            continue;
        }
        if let Some((p, _, _)) = ixs.iter().find(|(p, _, _)| *p != prog && *p != budget) {
            // Another program's instruction could change the table by CPI
            // only with the authority's signature: impossible when the
            // table is frozen (no authority), or when its authority is a
            // real key (on the curve: no program can sign for it) that did
            // not sign this transaction. Then the transaction only names
            // (or write-locks) the table, and changes nothing.
            let signed: Vec<Address> = d
                .static_keys
                .iter()
                .take(d.header.num_required_signatures as usize)
                .copied()
                .collect();
            let inert = !mine
                && b.as_ref().is_some_and(|t| match t.authority {
                    None => true,
                    Some(a) => a.is_on_curve() && !signed.contains(&a),
                });
            if inert {
                continue;
            }
            return Err(format!(
                "its transaction {} writes the table and also runs program {p} (a CPI could change the table unseen: not replayable)",
                r.signature
            )
            .into());
        }
        let signers = d.header.num_required_signatures as usize;
        for (ci, (p, accts, data)) in d.instructions.iter().zip(ixs.iter()) {
            if *p != prog || accts.first() != Some(table) {
                continue;
            }
            let ix = decode_ix(data).ok_or_else(|| {
                format!(
                    "its transaction {}: a lookup table instruction that does not decode",
                    r.signature
                )
            })?;
            // The authority is the instruction's second account; it signs
            // every instruction but Create.
            let auth = accts.get(1).copied();
            let auth_signed = ci.accounts.get(1).is_some_and(|&i| (i as usize) < signers);
            let why = |m: &str| Refused::from(format!("its transaction {}: {m}", r.signature));
            if b.as_ref().is_some_and(|b| b.closed_slot.is_some()) {
                return Err(why("an instruction after the table was closed"));
            }
            match ix {
                Ix::Create { recent_slot, bump } => {
                    let a = auth.ok_or_else(|| why("Create without an authority"))?;
                    let derived = Address::create_program_address(
                        &[a.as_ref(), &recent_slot.to_le_bytes(), &[bump]],
                        &prog,
                    )
                    .map_err(|_| why("Create's seeds derive no address"))?;
                    if derived != *table {
                        return Err(why(&format!(
                            "Create derives {derived}, not the table (authority {a}, slot {recent_slot}, bump {bump})"
                        )));
                    }
                    // A Create on an existing table succeeds and changes
                    // nothing (processor.rs: owner already the program).
                    if b.is_none() {
                        b = Some(Built {
                            authority: Some(a),
                            addresses: vec![],
                            created_slot: r.slot,
                            deactivated_slot: None,
                            closed_slot: None,
                            txs: 0,
                        });
                    }
                }
                other => {
                    let t = b
                        .as_mut()
                        .ok_or_else(|| why("an instruction before any CreateLookupTable"))?;
                    if t.authority.is_none() || t.authority != auth || !auth_signed {
                        return Err(why("an instruction not signed by the table's authority"));
                    }
                    match other {
                        Ix::Extend(new) => {
                            if t.deactivated_slot.is_some() {
                                return Err(why("Extend after deactivation"));
                            }
                            if new.is_empty() || t.addresses.len() + new.len() > 256 {
                                return Err(why(
                                    "an Extend the program refuses (empty or past 256)",
                                ));
                            }
                            t.addresses.extend(new.into_iter().map(|a| (a, r.slot)));
                        }
                        Ix::Freeze => t.authority = None,
                        Ix::Deactivate => {
                            if t.deactivated_slot.is_some() {
                                return Err(why("a second Deactivate"));
                            }
                            t.deactivated_slot = Some(r.slot);
                        }
                        Ix::Close => {
                            if t.deactivated_slot.is_none() {
                                return Err(why("Close before deactivation"));
                            }
                            t.closed_slot = Some(r.slot);
                        }
                        Ix::Create { .. } => unreachable!(),
                    }
                }
            }
        }
        if let Some(t) = b.as_mut() {
            t.txs += 1;
        }
    }
    b.ok_or_else(|| Refused::from("no successful CreateLookupTable in its history".to_string()))
}

// ------------------------------------------------------------ the snapshot

/// What findex archives about a lookup table the first time a season
/// transaction uses it (and what the verifier reads for a closed table):
/// the table's account as an RPC served it, the slot of that read, and the
/// table's own transactions up to then. Every part is optional (`None`: not
/// read), and none is trusted as given: VT judges each read by the same
/// rules as the final read (`verify::lookup`), VS has every witness confirm
/// it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub table: Address,
    /// The archived transaction it was taken for (`None`: taken by the
    /// verifier itself, for no one transaction).
    pub used_by: Option<(Signature, u64)>,
    /// `context.slot` of the account read (`None`: not said).
    pub read_slot: Option<u64>,
    /// The account read: `None` not read, `Some(None)` absent at the read.
    pub account: Option<Option<Account>>,
    /// The table's own transactions, oldest first (`None`: not read).
    pub history: Option<Vec<TxRecord>>,
    /// Who read it (report text: `findex`, `verifier`, `fixture`).
    pub source: String,
}

fn hist_json(r: &TxRecord) -> Value {
    let mut v = json!({"signature": r.signature.to_string(), "slot": r.slot, "block_time": r.block_time,
        "tx": B64.encode(&r.tx), "err": r.err});
    if !r.loaded.writable.is_empty() || !r.loaded.readonly.is_empty() {
        v["loaded"] = crate::vtx::loaded_json(&r.loaded);
    }
    v
}

fn hist_from(v: &Value) -> Result<TxRecord, String> {
    let e = |m: &str| format!("lookup snapshot history: {m}");
    Ok(TxRecord {
        seq: 0,
        slot: v.get("slot").and_then(|x| x.as_u64()).ok_or(e("slot"))?,
        signature: v
            .get("signature")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or(e("signature"))?,
        block_time: v.get("block_time").and_then(|x| x.as_i64()).unwrap_or(0),
        tx: B64
            .decode(v.get("tx").and_then(|x| x.as_str()).ok_or(e("tx"))?)
            .map_err(|x| e(&x.to_string()))?,
        logs: vec![],
        err: match v.get("err") {
            None | Some(Value::Null) => None,
            Some(x) => Some(x.as_str().ok_or(e("err"))?.to_string()),
        },
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
        loaded: crate::vtx::loaded_from_meta(
            &json!({"loadedAddresses": v.get("loaded").cloned().unwrap_or(Value::Null)}),
        )?,
    })
}

impl Snapshot {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "table": self.table.to_string(),
            "used_by": self.used_by.map(|(s, slot)| json!([s.to_string(), slot])),
            "read_slot": self.read_slot,
            "source": self.source,
        });
        if let Some(a) = &self.account {
            v["account"] = a.as_ref().map_or(Value::Null, account_json);
        }
        if let Some(h) = &self.history {
            v["history"] = Value::Array(h.iter().map(hist_json).collect());
        }
        v
    }

    /// Strict: present but unreadable is an error.
    pub fn from_json(v: &Value) -> Result<Snapshot, String> {
        let e = |m: &str| format!("lookup snapshot: {m}");
        Ok(Snapshot {
            table: v
                .get("table")
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse().ok())
                .ok_or(e("table"))?,
            used_by: match v.get("used_by") {
                None | Some(Value::Null) => None,
                Some(u) => Some((
                    u.get(0)
                        .and_then(|x| x.as_str())
                        .and_then(|s| s.parse().ok())
                        .ok_or(e("used_by"))?,
                    u.get(1).and_then(|x| x.as_u64()).ok_or(e("used_by"))?,
                )),
            },
            read_slot: match v.get("read_slot") {
                None | Some(Value::Null) => None,
                Some(x) => Some(x.as_u64().ok_or(e("read_slot"))?),
            },
            account: match v.get("account") {
                None => None,
                Some(a) => Some(parse_account(a).map_err(|x| e(&x.to_string()))?),
            },
            history: match v.get("history") {
                None | Some(Value::Null) => None,
                Some(h) => Some(
                    h.as_array()
                        .ok_or(e("history"))?
                        .iter()
                        .map(hist_from)
                        .collect::<Result<_, _>>()?,
                ),
            },
            source: v
                .get("source")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
        })
    }
}

// ------------------------------------------------------------ the reads

/// The table's account at `min_slot` or later (finalized), with the slot
/// the node read it at (`context.slot`).
pub async fn read_account(
    rpc: &RpcClient,
    table: &Address,
    min_slot: u64,
) -> PortResult<(Option<Account>, u64)> {
    let mut cfg = json!({"encoding": "base64", "commitment": "finalized"});
    if min_slot > 0 {
        cfg["minContextSlot"] = json!(min_slot);
    }
    let v = rpc
        .call("getMultipleAccounts", json!([[table.to_string()], cfg]))
        .await?;
    let slot = v
        .pointer("/context/slot")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| PortError::Decode("context.slot".into()))?;
    let a = v
        .pointer("/value/0")
        .ok_or_else(|| PortError::Decode("value".into()))?;
    Ok((parse_account(a)?, slot))
}

/// Most successful transactions of one table's history read
/// ([`read_history`]). A lookup table holds at most 256 addresses, so an
/// honest history (one Create, ≤ 256 Extends of ≥ 1 address, Freeze,
/// Deactivate, Close) has at most 260 successful transactions; anything
/// longer is someone else's transactions naming the table.
pub const HISTORY_MAX: usize = 300;
/// Most signatures listed for one table (failed ones included, which are
/// never fetched: a failed transaction changes no table).
pub const LIST_MAX: usize = 5_000;

/// The table's own successful transactions, oldest first (finalized
/// `getSignaturesForAddress` of the table paged to its end, then
/// `getTransaction` for each one listed as successful; failed ones change
/// nothing and are not read). `Ok(None)`: longer than [`LIST_MAX`] /
/// [`HISTORY_MAX`] — not read (anyone can name a table in their own
/// transactions; a long list must never stall the archive). A transaction
/// the node lists but does not serve, or any RPC error, is an error.
pub async fn read_history(rpc: &RpcClient, table: &Address) -> PortResult<Option<Vec<TxRecord>>> {
    let mut listed: Vec<Signature> = vec![];
    let mut ok: Vec<Signature> = vec![];
    let mut before: Option<Signature> = None;
    loop {
        let page = rpc
            .get_finalized_signatures_for_address(table, before.as_ref(), None, 1_000)
            .await?;
        let n = page.len();
        for s in &page {
            if listed.contains(&s.signature) {
                return Err(PortError::Decode(
                    "getSignaturesForAddress served a signature twice".into(),
                ));
            }
            listed.push(s.signature);
            if !s.failed {
                ok.push(s.signature);
            }
        }
        if listed.len() > LIST_MAX || ok.len() > HISTORY_MAX {
            return Ok(None);
        }
        if n < 1_000 {
            break;
        }
        before = page.last().map(|s| s.signature);
    }
    let mut out = Vec::with_capacity(ok.len());
    for s in ok.iter().rev() {
        let t = rpc
            .get_finalized_transaction(s)
            .await?
            .ok_or_else(|| PortError::Decode(format!("transaction {s} listed but not served")))?;
        out.push(t);
    }
    Ok(Some(out))
}

/// findex's snapshot of `table` for the archived transaction `used_by`:
/// the account read at its slot or later, then the table's history (`None`
/// when too long to read, [`read_history`]).
pub async fn snapshot(
    rpc: &RpcClient,
    table: &Address,
    used_by: (Signature, u64),
) -> PortResult<Snapshot> {
    let (account, read_slot) = read_account(rpc, table, used_by.1).await?;
    let history = read_history(rpc, table).await?;
    Ok(Snapshot {
        table: *table,
        used_by: Some(used_by),
        read_slot: Some(read_slot),
        account: Some(account),
        history,
        source: "findex".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_decode_exactly() {
        let mut c = 0u32.to_le_bytes().to_vec();
        c.extend_from_slice(&7u64.to_le_bytes());
        c.push(254);
        assert_eq!(
            decode_ix(&c),
            Some(Ix::Create {
                recent_slot: 7,
                bump: 254
            })
        );
        c.push(0);
        assert_eq!(decode_ix(&c), None, "a trailing byte");
        let a = Address::new_from_array([9; 32]);
        let mut e = 2u32.to_le_bytes().to_vec();
        e.extend_from_slice(&1u64.to_le_bytes());
        e.extend_from_slice(a.as_ref());
        assert_eq!(decode_ix(&e), Some(Ix::Extend(vec![a])));
        e.pop();
        assert_eq!(decode_ix(&e), None, "short");
        assert_eq!(decode_ix(&3u32.to_le_bytes()), Some(Ix::Deactivate));
        assert_eq!(decode_ix(&9u32.to_le_bytes()), None);
    }

    #[test]
    fn table_bytes_decode_and_classify() {
        let a = Address::new_from_array([5; 32]);
        let auth = Address::new_from_array([6; 32]);
        let mut d = 1u32.to_le_bytes().to_vec();
        d.extend_from_slice(&u64::MAX.to_le_bytes());
        d.extend_from_slice(&3u64.to_le_bytes());
        d.push(0);
        d.push(1);
        d.extend_from_slice(auth.as_ref());
        d.extend_from_slice(&[0, 0]);
        assert_eq!(d.len(), META);
        d.extend_from_slice(a.as_ref());
        let t = decode_table(&program(), &d).unwrap();
        assert_eq!(t.addresses, vec![a]);
        assert_eq!(t.authority, Some(auth));
        assert_eq!(t.deactivation_slot, u64::MAX);
        let acc = Account {
            lamports: 1,
            data: d.clone(),
            owner: program(),
            executable: false,
        };
        assert!(matches!(classify(Some(&acc)), Read::Table(_)));
        let refunded = Account {
            lamports: 5,
            data: vec![],
            owner: crate::addr::system_program(),
            executable: false,
        };
        assert_eq!(classify(Some(&refunded)), Read::Closed);
        assert_eq!(classify(None), Read::Closed);
        let foreign = Account {
            owner: Address::new_from_array([1; 32]),
            ..acc
        };
        assert!(matches!(classify(Some(&foreign)), Read::Foreign(_)));
        assert!(prefix_compatible(&[a], &[a, auth]));
        assert!(!prefix_compatible(&[auth], &[a, auth]));
    }

    // ---- replay over real signed transactions

    use crate::{AccountMeta, Instruction, Keypair, Signer};

    fn rec(slot: u64, signers: &[&Keypair], ixs: &[Instruction], err: bool) -> TxRecord {
        let m = solana_message::Message::new_with_blockhash(
            ixs,
            Some(&signers[0].pubkey()),
            &crate::Hash::default(),
        );
        let t = crate::tx::sign(m, signers).unwrap();
        TxRecord {
            slot,
            signature: t.signatures[0],
            tx: crate::tx::wire(&t),
            err: err.then(|| "InstructionError".to_string()),
            ..TxRecord::default()
        }
    }

    fn table_of(auth: &Address) -> (Address, u64, u8) {
        for slot in 1..100u64 {
            for bump in (0..=255u8).rev() {
                if let Ok(a) = Address::create_program_address(
                    &[auth.as_ref(), &slot.to_le_bytes(), &[bump]],
                    &program(),
                ) {
                    return (a, slot, bump);
                }
            }
        }
        unreachable!()
    }

    fn create(t: &Address, auth: &Address, slot: u64, bump: u8) -> Instruction {
        let mut d = 0u32.to_le_bytes().to_vec();
        d.extend_from_slice(&slot.to_le_bytes());
        d.push(bump);
        Instruction {
            program_id: program(),
            accounts: vec![
                AccountMeta::new(*t, false),
                AccountMeta::new_readonly(*auth, false),
                AccountMeta::new(*auth, true),
                AccountMeta::new_readonly(crate::addr::system_program(), false),
            ],
            data: d,
        }
    }

    fn extend(t: &Address, auth: &Address, new: &[Address]) -> Instruction {
        let mut d = 2u32.to_le_bytes().to_vec();
        d.extend_from_slice(&(new.len() as u64).to_le_bytes());
        for a in new {
            d.extend_from_slice(a.as_ref());
        }
        Instruction {
            program_id: program(),
            accounts: vec![
                AccountMeta::new(*t, false),
                AccountMeta::new_readonly(*auth, true),
                AccountMeta::new(*auth, true),
                AccountMeta::new_readonly(crate::addr::system_program(), false),
            ],
            data: d,
        }
    }

    #[test]
    fn replay_builds_the_table_from_its_signed_transactions() {
        let auth = Keypair::new_from_array([41; 32]);
        let other = Keypair::new_from_array([42; 32]);
        let (t, slot, bump) = table_of(&auth.pubkey());
        let (a, b) = (
            Address::new_from_array([1; 32]),
            Address::new_from_array([2; 32]),
        );
        // someone else write-locks the table under the System program
        let mut junk = crate::tx::transfer(other.pubkey(), other.pubkey(), 1);
        junk.accounts.push(AccountMeta::new(t, false));
        let h = vec![
            rec(
                10,
                &[&auth],
                &[create(&t, &auth.pubkey(), slot, bump)],
                false,
            ),
            rec(11, &[&auth], &[extend(&t, &auth.pubkey(), &[a])], false),
            rec(
                11,
                &[&auth],
                &[extend(
                    &t,
                    &auth.pubkey(),
                    &[Address::new_from_array([9; 32])],
                )],
                true,
            ),
            rec(12, &[&other], &[junk.clone()], false),
            rec(13, &[&auth], &[extend(&t, &auth.pubkey(), &[b])], false),
        ];
        let built = replay(&t, &h).expect("replays");
        assert_eq!(
            built.list(),
            vec![a, b],
            "the failed Extend changes nothing; the junk is inert"
        );
        assert_eq!(built.addresses[1].1, 13);
        assert_eq!(built.authority, Some(auth.pubkey()));
        // the same junk SIGNED by the authority could have extended by CPI
        let mut h2 = h.clone();
        let mut signed_junk = junk.clone();
        signed_junk
            .accounts
            .push(AccountMeta::new_readonly(auth.pubkey(), true));
        h2[3] = rec(12, &[&other, &auth], &[signed_junk], false);
        let e = replay(&t, &h2).unwrap_err();
        assert!(!e.forged, "{e}");
        // an Extend by a non-authority
        let mut h3 = h.clone();
        h3[1] = rec(11, &[&other], &[extend(&t, &other.pubkey(), &[a])], false);
        assert!(!replay(&t, &h3).unwrap_err().forged);
        // a Create of another address
        let mut h4 = h.clone();
        h4[0] = rec(
            10,
            &[&auth],
            &[create(&t, &auth.pubkey(), slot, bump.wrapping_sub(1))],
            false,
        );
        assert!(replay(&t, &h4).is_err());
        // no Create at all
        assert!(replay(&t, &h[1..]).is_err());
        // bytes edited after signing: forged
        let mut h5 = h.clone();
        let n = h5[1].tx.len();
        h5[1].tx[n - 1] ^= 1;
        assert!(replay(&t, &h5).unwrap_err().forged);
        // a record whose signature is another transaction's: forged
        let mut h6 = h.clone();
        h6[1].signature = h6[4].signature;
        assert!(replay(&t, &h6).unwrap_err().forged);
        // out of slot order
        let mut h7 = h.clone();
        h7.swap(1, 4);
        assert!(!replay(&t, &h7).unwrap_err().forged);
        // the snapshot JSON round-trips
        let s = Snapshot {
            table: t,
            used_by: Some((h[1].signature, 20)),
            read_slot: Some(21),
            account: Some(None),
            history: Some(h.clone()),
            source: "findex".into(),
        };
        let back = Snapshot::from_json(&s.to_json()).unwrap();
        assert_eq!(back.account, Some(None));
        assert_eq!(back.history.as_ref().unwrap().len(), h.len());
        assert_eq!(replay(&t, back.history.as_ref().unwrap()).unwrap(), built);
        let none = Snapshot {
            account: None,
            history: None,
            ..s
        };
        let back = Snapshot::from_json(&none.to_json()).unwrap();
        assert_eq!(back.account, None);
        assert_eq!(back.history, None);
    }
}
