//! Versioned transactions as the readers of the chain's history see them
//! (herald-v0v1-decode): legacy, **v0** (address lookup tables) and **v1**
//! (SIMD-0385, prefix `0x81`; B5 measured them on devnet 2026-11-21).
//!
//! [`crate::tx::from_wire`] stays legacy-only on purpose: the relay, the
//! localnet admission rules and the verifier's re-execution build or check
//! legacy messages, and a v0/v1 transaction must stay "undecodable" there
//! until each of them handles it (the verifier's V1 `Undecodable` is a
//! fail-safe, never a PASS). This module is for the INGEST side — findex,
//! herald, keeper feed — which only needs to know which accounts a landed
//! transaction named, which of them it could write, and its instructions.
//!
//! The account list of a landed v0 transaction is the agave order
//! (`solana_message::AccountKeys::new(static, Some(&loaded))`): the static
//! keys, then every lookup's writable addresses, then every lookup's
//! readonly addresses. The addresses a lookup resolved to are what the
//! cluster reports in `meta.loadedAddresses` of `getTransaction` (as
//! web3.js `getAccountKeys({accountKeysFromLookups})` and the Geyser
//! `loaded_writable_addresses` / `loaded_readonly_addresses` do); they are
//! not re-derived here from today's table (a table can be extended,
//! deactivated and closed after the transaction landed).

use solana_address::Address;
use solana_hash::Hash;
use solana_message::compiled_instruction::CompiledInstruction;
pub use solana_message::v0::{LoadedAddresses, MessageAddressTableLookup};
use solana_message::{MessageHeader, VersionedMessage};
use solana_signature::Signature;
pub use solana_transaction::versioned::VersionedTransaction;

/// The wire format of a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Version {
    Legacy,
    V0,
    V1,
}

impl Version {
    /// As `getTransaction`'s `version` field: `"legacy"`, `0`, `1`.
    pub fn json(self) -> serde_json::Value {
        match self {
            Version::Legacy => serde_json::Value::String("legacy".into()),
            Version::V0 => serde_json::json!(0),
            Version::V1 => serde_json::json!(1),
        }
    }
}

/// One instruction with its program id and accounts resolved: (program id,
/// its account keys in order, its data).
pub type ResolvedIx = (Address, Vec<Address>, Vec<u8>);

/// One decoded wire transaction of any supported version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    pub version: Version,
    pub signatures: Vec<Signature>,
    pub header: MessageHeader,
    /// The keys written in the message itself (all of them for legacy/v1).
    pub static_keys: Vec<Address>,
    /// v0 only: the lookups (empty for legacy and v1).
    pub lookups: Vec<MessageAddressTableLookup>,
    pub instructions: Vec<CompiledInstruction>,
    pub blockhash: Hash,
    pub tx: VersionedTransaction,
}

/// Whether the wire is a versioned (v0 / v1) transaction: a v1 one starts
/// with its prefix (`0x81`); a legacy or v0 one with the short-vec count of
/// its signatures, and then the message's first byte has the top bit set
/// for v0 (`0x80`) and clear for legacy (a header's signer count < 128).
pub fn is_versioned(wire: &[u8]) -> bool {
    match wire.first() {
        None => false,
        Some(&b) if b & 0x80 != 0 => true,
        Some(&n) => wire.get(1 + 64 * n as usize).is_some_and(|m| m & 0x80 != 0),
    }
}

/// Decodes legacy, v0 and v1 wire bytes. A legacy wire is read exactly as
/// [`crate::tx::from_wire`] reads it (every legacy reader keeps its
/// behaviour); a v0 / v1 wire must be exactly one transaction and re-encode
/// to itself (no trailing or non-canonical bytes), so the decoded form IS
/// what was signed.
pub fn decode(wire: &[u8]) -> Result<Decoded, String> {
    let tx: VersionedTransaction = if is_versioned(wire) {
        let tx: VersionedTransaction =
            wincode::deserialize_exact(wire).map_err(|e| format!("versioned transaction: {e}"))?;
        let back = wincode::serialize(&tx).map_err(|e| format!("versioned transaction: {e}"))?;
        if back != wire {
            return Err("versioned transaction: not canonical".into());
        }
        if matches!(tx.message, VersionedMessage::Legacy(_)) {
            return Err("versioned transaction: a legacy message".into());
        }
        tx
    } else {
        VersionedTransaction::from(crate::tx::from_wire(wire)?)
    };
    let (version, header, static_keys, lookups, instructions, blockhash) = match &tx.message {
        VersionedMessage::Legacy(m) => (
            Version::Legacy,
            m.header,
            m.account_keys.clone(),
            vec![],
            m.instructions.clone(),
            m.recent_blockhash.to_bytes(),
        ),
        VersionedMessage::V0(m) => (
            Version::V0,
            m.header,
            m.account_keys.clone(),
            m.address_table_lookups.clone(),
            m.instructions.clone(),
            m.recent_blockhash.to_bytes(),
        ),
        VersionedMessage::V1(m) => (
            Version::V1,
            m.header,
            m.account_keys.clone(),
            vec![],
            m.instructions.clone(),
            m.lifetime_specifier.to_bytes(),
        ),
    };
    if tx.signatures.len() != header.num_required_signatures as usize {
        return Err(format!(
            "versioned transaction: {} signatures for {} required",
            tx.signatures.len(),
            header.num_required_signatures
        ));
    }
    if static_keys.len() < header.num_required_signatures as usize {
        return Err("versioned transaction: fewer keys than signers".into());
    }
    Ok(Decoded {
        version,
        signatures: tx.signatures.clone(),
        header,
        static_keys,
        lookups,
        instructions,
        blockhash: Hash::new_from_array(blockhash),
        tx,
    })
}

/// Wire bytes of a versioned transaction (legacy and v0 as bincode wrote
/// them; v1 as SIMD-0385: message first, then the signatures).
pub fn wire(tx: &VersionedTransaction) -> Result<Vec<u8>, String> {
    wincode::serialize(tx).map_err(|e| e.to_string())
}

impl Decoded {
    /// The first signature (the transaction id).
    pub fn signature(&self) -> Signature {
        self.signatures.first().copied().unwrap_or_default()
    }

    /// The fee payer (always the first static key).
    pub fn fee_payer(&self) -> Option<Address> {
        self.static_keys.first().copied()
    }

    /// How many writable and readonly addresses the lookups name.
    pub fn lookup_counts(&self) -> (usize, usize) {
        self.lookups.iter().fold((0, 0), |(w, r), l| {
            (w + l.writable_indexes.len(), r + l.readonly_indexes.len())
        })
    }

    /// Whether `loaded` fits the lookups (the same number of writable and
    /// readonly addresses; none for legacy, v1 and a v0 without lookups).
    pub fn check_loaded(&self, loaded: &LoadedAddresses) -> Result<(), String> {
        let (w, r) = self.lookup_counts();
        if loaded.writable.len() != w || loaded.readonly.len() != r {
            return Err(format!(
                "the lookups name {w} writable + {r} readonly addresses, the record carries {} + {}{}",
                loaded.writable.len(),
                loaded.readonly.len(),
                if loaded.writable.is_empty() && loaded.readonly.is_empty() {
                    " (meta.loadedAddresses missing)"
                } else {
                    ""
                }
            ));
        }
        Ok(())
    }

    /// Every account of the transaction in the runtime's order: static
    /// keys, the lookups' writable addresses, their readonly addresses.
    pub fn keys(&self, loaded: &LoadedAddresses) -> Result<Vec<Address>, String> {
        self.check_loaded(loaded)?;
        let mut v = self.static_keys.clone();
        v.extend_from_slice(&loaded.writable);
        v.extend_from_slice(&loaded.readonly);
        Ok(v)
    }

    /// Writable by the message header (static keys) or as a lookup's
    /// writable address — before any runtime demotion, like
    /// [`crate::tx::is_writable_index`] (`i` indexes [`Decoded::keys`]).
    pub fn is_writable_index(&self, i: usize, loaded: &LoadedAddresses) -> bool {
        let h = &self.header;
        let n = self.static_keys.len();
        let (sig, ro_sig, ro_unsig) = (
            h.num_required_signatures as usize,
            h.num_readonly_signed_accounts as usize,
            h.num_readonly_unsigned_accounts as usize,
        );
        if i >= n {
            i - n < loaded.writable.len()
        } else if i < sig {
            i < sig.saturating_sub(ro_sig)
        } else {
            i < n.saturating_sub(ro_unsig)
        }
    }

    /// The writable accounts (in [`Decoded::keys`] order).
    pub fn writable_keys(&self, loaded: &LoadedAddresses) -> Result<Vec<Address>, String> {
        let keys = self.keys(loaded)?;
        Ok((0..keys.len())
            .filter(|&i| self.is_writable_index(i, loaded))
            .map(|i| keys[i])
            .collect())
    }

    /// Each instruction as (program id, its account keys, its data). A
    /// program id is always a static key (sanitize rule of v0); an account
    /// index past the resolved list is an error.
    pub fn instructions_resolved(
        &self,
        loaded: &LoadedAddresses,
    ) -> Result<Vec<ResolvedIx>, String> {
        let keys = self.keys(loaded)?;
        self.instructions
            .iter()
            .map(|ix| {
                let p = *self
                    .static_keys
                    .get(ix.program_id_index as usize)
                    .ok_or("program id index")?;
                let a = ix
                    .accounts
                    .iter()
                    .map(|&i| keys.get(i as usize).copied().ok_or("account index"))
                    .collect::<Result<Vec<_>, _>>()?;
                Ok((p, a, ix.data.clone()))
            })
            .collect()
    }

    /// Whether `k` is one of the transaction's accounts (static or loaded).
    pub fn mentions(&self, k: &Address, loaded: &LoadedAddresses) -> bool {
        self.static_keys.contains(k) || loaded.writable.contains(k) || loaded.readonly.contains(k)
    }
}

/// `meta.loadedAddresses` of a `getTransaction` / `getBlock` result
/// (`{"writable": [b58…], "readonly": [b58…]}`); absent or null = none
/// (a legacy transaction, or a node that does not report it). A present
/// but malformed value is an error.
pub fn loaded_from_meta(meta: &serde_json::Value) -> Result<LoadedAddresses, String> {
    let Some(la) = meta.get("loadedAddresses").filter(|v| !v.is_null()) else {
        return Ok(LoadedAddresses::default());
    };
    let list = |k: &str| -> Result<Vec<Address>, String> {
        match la.get(k) {
            None | Some(serde_json::Value::Null) => Ok(vec![]),
            Some(serde_json::Value::Array(a)) => a
                .iter()
                .map(|x| {
                    x.as_str()
                        .and_then(|s| s.parse::<Address>().ok())
                        .ok_or_else(|| format!("loadedAddresses.{k}: not an address"))
                })
                .collect(),
            Some(_) => Err(format!("loadedAddresses.{k}: not a list")),
        }
    };
    Ok(LoadedAddresses {
        writable: list("writable")?,
        readonly: list("readonly")?,
    })
}

/// The JSON form of [`loaded_from_meta`].
pub fn loaded_json(l: &LoadedAddresses) -> serde_json::Value {
    serde_json::json!({
        "writable": l.writable.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
        "readonly": l.readonly.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_message::v0;

    // Key-free (CI owner rule 2026-11-06): no key is generated or signs
    // here; every transaction carries a fixed placeholder signature (the
    // decoders never verify one). The recorded devnet transaction's real
    // signature is only verified.
    fn a(i: u8) -> Address {
        Address::new_from_array([i; 32])
    }

    /// The fee payer of these tests (a fixed address, no key behind it).
    fn payer() -> Address {
        a(0x99)
    }

    fn unsigned(m: VersionedMessage) -> VersionedTransaction {
        let n = m.header().num_required_signatures as usize;
        VersionedTransaction {
            signatures: (0..n)
                .map(|i| Signature::from([0x5a ^ i as u8; 64]))
                .collect(),
            message: m,
        }
    }

    #[test]
    fn legacy_decodes_as_tx_from_wire_does() {
        let ix = crate::tx::transfer(payer(), a(7), 5);
        let budget = crate::tx::TxBudget {
            cu_limit: 1000,
            cu_price: 0,
            loaded_limit: 4096,
            heap: None,
        };
        let t = solana_transaction::Transaction {
            signatures: vec![Signature::from([0x5a; 64])],
            message: crate::tx::message(&[ix], &budget, &payer(), &Hash::new_from_array([3; 32])),
        };
        let w = crate::tx::wire(&t);
        let d = decode(&w).unwrap();
        assert_eq!(d.version, Version::Legacy);
        assert_eq!(d.static_keys, t.message.account_keys);
        assert_eq!(d.signature(), crate::tx::signature(&t));
        let none = LoadedAddresses::default();
        for i in 0..d.static_keys.len() {
            assert_eq!(
                d.is_writable_index(i, &none),
                crate::tx::is_writable_index(&t.message, i)
            );
        }
        assert_eq!(wire(&d.tx).unwrap(), w);
        assert!(!is_versioned(&w));
        // a legacy wire reads exactly as the legacy decoder reads it
        let mut long = w.clone();
        long.push(0);
        assert_eq!(
            decode(&long).is_ok(),
            crate::tx::from_wire(&long).is_ok(),
            "trailing byte"
        );
        assert!(decode(&w[..w.len() - 1]).is_err(), "short");
    }

    #[test]
    fn v0_keys_follow_the_runtime_order() {
        let table = a(50);
        let ix = solana_instruction::Instruction {
            program_id: a(9),
            accounts: vec![
                solana_instruction::AccountMeta::new(payer(), true),
                solana_instruction::AccountMeta::new(a(20), false),
                solana_instruction::AccountMeta::new_readonly(a(21), false),
                solana_instruction::AccountMeta::new(a(22), false),
            ],
            data: vec![1, 2, 3],
        };
        let alt = solana_message::AddressLookupTableAccount {
            key: table,
            addresses: vec![a(21), a(20), a(30)],
        };
        let m = v0::Message::try_compile(&payer(), &[ix], &[alt], Hash::new_from_array([4; 32]))
            .unwrap();
        let t = unsigned(VersionedMessage::V0(m));
        let w = wire(&t).unwrap();
        assert_eq!(w[1 + 64], 0x80, "the v0 prefix follows the one signature");
        assert!(is_versioned(&w));
        let mut long = w.clone();
        long.push(0);
        assert!(
            decode(&long).is_err(),
            "a trailing byte after a v0 transaction"
        );
        let d = decode(&w).unwrap();
        assert_eq!(d.version, Version::V0);
        assert_eq!(d.lookup_counts(), (1, 1));
        // the static keys: payer, the non-table writable, the program
        assert!(d.static_keys.contains(&a(22)) && d.static_keys.contains(&a(9)));
        let none = LoadedAddresses::default();
        assert!(d.keys(&none).is_err(), "unresolved lookups are refused");
        let loaded = LoadedAddresses {
            writable: vec![a(20)],
            readonly: vec![a(21)],
        };
        let keys = d.keys(&loaded).unwrap();
        assert_eq!(&keys[keys.len() - 2..], &[a(20), a(21)]);
        let wk = d.writable_keys(&loaded).unwrap();
        assert!(wk.contains(&payer()) && wk.contains(&a(22)) && wk.contains(&a(20)));
        assert!(!wk.contains(&a(21)) && !wk.contains(&a(9)));
        let ixs = d.instructions_resolved(&loaded).unwrap();
        assert_eq!(ixs.len(), 1);
        assert_eq!(ixs[0].0, a(9));
        assert_eq!(ixs[0].1, vec![payer(), a(20), a(21), a(22)]);
        assert_eq!(ixs[0].2, vec![1, 2, 3]);
        assert!(d.mentions(&a(20), &loaded) && !d.mentions(&a(20), &none));
        assert!(
            crate::tx::from_wire(&w).is_err(),
            "the legacy decoder refuses v0"
        );
    }

    #[test]
    fn v1_builds_and_decodes() {
        let ix = solana_instruction::Instruction {
            program_id: a(9),
            accounts: vec![
                solana_instruction::AccountMeta::new(payer(), true),
                solana_instruction::AccountMeta::new(a(20), false),
                solana_instruction::AccountMeta::new_readonly(a(21), false),
            ],
            data: vec![5; 40],
        };
        let m = solana_message::v1::Message::try_compile(
            &payer(),
            &[ix],
            Hash::new_from_array([6; 32]),
        )
        .unwrap();
        let t = unsigned(VersionedMessage::V1(m));
        let w = wire(&t).unwrap();
        assert_eq!(
            w[0], 0x81,
            "v1 starts with its prefix, the signatures come last"
        );
        assert!(is_versioned(&w));
        assert!(
            decode(&w[..w.len() - 1]).is_err(),
            "a v1 transaction cut short"
        );
        let d = decode(&w).unwrap();
        assert_eq!(d.version, Version::V1);
        assert_eq!(d.signature(), t.signatures[0]);
        assert_eq!(&w[w.len() - 64..], t.signatures[0].as_ref());
        let none = LoadedAddresses::default();
        let wk = d.writable_keys(&none).unwrap();
        assert!(wk.contains(&payer()) && wk.contains(&a(20)));
        assert!(!wk.contains(&a(21)) && !wk.contains(&a(9)));
        let ixs = d.instructions_resolved(&none).unwrap();
        assert_eq!((ixs[0].0, ixs[0].2.len()), (a(9), 40));
        assert!(
            d.keys(&LoadedAddresses {
                writable: vec![a(1)],
                readonly: vec![]
            })
            .is_err(),
            "a v1 transaction has no lookups: loaded addresses do not fit"
        );
        assert!(crate::tx::from_wire(&w).is_err());
    }

    /// The version-1 transaction B5 recorded from devnet (slot 523,600,000,
    /// `getTransaction` with `maxSupportedTransactionVersion: 1`).
    #[test]
    fn the_recorded_devnet_v1_transaction_decodes() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/devnet-b5/getTransaction-v1-max1.json"
        ))
        .unwrap();
        let r = &v["result"];
        use base64::Engine;
        let w = base64::engine::general_purpose::STANDARD
            .decode(r["transaction"][0].as_str().unwrap())
            .unwrap();
        let d = decode(&w).unwrap();
        assert_eq!(d.version, Version::V1);
        assert_eq!(d.version.json(), r["version"]);
        assert_eq!(
            d.signature().to_string(),
            "4t9MfiyECe35pAzgAupvqBYJ9dYXciYyUKNU9heES1AxFPNhSfXGrt2w75nxpL2ggJqS9ihSK6RcSq6NBkDkYb2x"
        );
        let loaded = loaded_from_meta(&r["meta"]).unwrap();
        assert_eq!(loaded, LoadedAddresses::default());
        let keys = d.keys(&loaded).unwrap();
        assert_eq!(
            keys.len(),
            r["meta"]["preBalances"].as_array().unwrap().len(),
            "one balance per account, as the node reports them"
        );
        // the signature verifies over the message bytes (all before it)
        assert!(d.tx.verify_with_results().iter().all(|ok| *ok));
    }

    #[test]
    fn meta_loaded_addresses_parse() {
        let m = serde_json::json!({"loadedAddresses": {"writable": [a(1).to_string()], "readonly": []}});
        let l = loaded_from_meta(&m).unwrap();
        assert_eq!(l.writable, vec![a(1)]);
        assert_eq!(
            loaded_from_meta(&loaded_json(&l).clone().pipe()).unwrap(),
            l
        );
        assert_eq!(
            loaded_from_meta(&serde_json::json!({})).unwrap(),
            LoadedAddresses::default()
        );
        assert!(
            loaded_from_meta(&serde_json::json!({"loadedAddresses": {"writable": ["x"]}})).is_err()
        );
        assert!(
            loaded_from_meta(&serde_json::json!({"loadedAddresses": {"writable": 1}})).is_err()
        );
    }

    trait Pipe {
        fn pipe(self) -> serde_json::Value;
    }
    impl Pipe for serde_json::Value {
        fn pipe(self) -> serde_json::Value {
            serde_json::json!({ "loadedAddresses": self })
        }
    }
}
