//! verifier-v0v1: every archived transaction as the verifier reads it —
//! legacy, **v0** (address lookup tables) and **v1** (SIMD-0385, prefix
//! `0x81`) — on `fclient::vtx` (herald-v0v1-decode, #154).
//!
//! Before this module the verifier read `fclient::tx::from_wire` (legacy
//! only), so any v0/v1 player transaction made the season FAIL
//! `Undecodable` (V1). Now:
//!
//! - a **legacy** wire is read exactly as before (`vtx::decode` reads it
//!   with `tx::from_wire`; a legacy record that carries looked-up addresses
//!   is refused), so a legacy-only archive keeps its verdict;
//! - a **v0** wire's account list is the runtime's (agave
//!   `AccountKeys::new(static, Some(&loaded))`): the static keys, every
//!   lookup's writable addresses, then every lookup's readonly ones. The
//!   looked-up addresses are the record's `loaded` (`meta.loadedAddresses`,
//!   findex archive field `loaded`); their counts must equal the lookups'
//!   or the transaction does not decode. They are **not trusted**: VT
//!   ([`crate::lookup`]) checks each of them against the lookup table
//!   account itself as read at the pinned slot (FAIL on any difference,
//!   UNVERIFIABLE when the table could not be read), and the re-execution
//!   (VX/VG, [`crate::reexec`]) runs the v0 transaction as signed, its
//!   lookups resolved by LiteSVM against a table holding exactly those
//!   addresses at exactly those indexes;
//! - a **v1** wire has no lookups; its compute budget is its config mask
//!   ([`Msg::budget`], as the local node and agave's runtime read it).
//!
//! A versioned wire must be one canonical transaction that sanitizes (the
//! cluster refuses any other before it lands); anything else, and any
//! unknown version byte, is undecodable — V1 FAILs it, never a PASS.

use fclient::ports::TxRecord;
use fclient::vtx::{self, Decoded, LoadedAddresses, Version, VersionedTransaction};
use solana_address::Address;
use solana_message::{Message, VersionedMessage};

/// One archived transaction of any supported version, its lookups (v0)
/// resolved by the record's `loaded`.
#[derive(Clone, Debug)]
pub struct Msg {
    pub d: Decoded,
    pub loaded: LoadedAddresses,
    /// Every account in the runtime's order.
    pub keys: Vec<Address>,
    /// A legacy-shaped view (the keys above, the message's header,
    /// blockhash and instructions) for the readers written against legacy
    /// messages: instruction program ids and account indexes resolve
    /// through it exactly as the runtime resolves them. Writability comes
    /// from [`Msg::is_writable_index`], never from this view's header
    /// (for legacy the two agree). Identical to the legacy message for a
    /// legacy wire.
    pub view: Message,
}

impl Msg {
    /// The record's transaction with its archived `loaded` addresses.
    pub fn of(rec: &TxRecord) -> Result<Msg, String> {
        Msg::decode(&rec.tx, &rec.loaded)
    }

    pub fn decode(wire: &[u8], loaded: &LoadedAddresses) -> Result<Msg, String> {
        let d = vtx::decode(wire)?;
        if d.version != Version::Legacy {
            d.tx.sanitize()
                .map_err(|e| format!("{:?} transaction does not sanitize: {e}", d.version))?;
        }
        let keys = d.keys(loaded)?;
        if d.version == Version::V0 {
            // The runtime refuses an account named twice (account locks);
            // a record whose looked-up addresses repeat a key is not one
            // the cluster executed.
            let mut seen = std::collections::BTreeSet::new();
            if let Some(k) = keys.iter().find(|k| !seen.insert(**k)) {
                return Err(format!(
                    "v0 transaction: account {k} is named twice (static keys + loadedAddresses)"
                ));
            }
            // Every index resolves (sanitize checked the static part).
            d.instructions_resolved(loaded)?;
        }
        let view = Message {
            header: d.header,
            account_keys: keys.clone(),
            recent_blockhash: d.blockhash,
            instructions: d.instructions.clone(),
        };
        Ok(Msg {
            d,
            loaded: loaded.clone(),
            keys,
            view,
        })
    }

    pub fn version(&self) -> Version {
        self.d.version
    }

    /// Writable by the message header (static keys) or as a lookup's
    /// writable address, before any runtime demotion (as
    /// `fclient::tx::is_writable_index` for legacy).
    pub fn is_writable_index(&self, i: usize) -> bool {
        self.d.is_writable_index(i, &self.loaded)
    }

    pub fn signers(&self) -> usize {
        self.d.header.num_required_signatures as usize
    }

    /// The compute budget: a legacy / v0 message's ComputeBudget
    /// instructions; a v1 message's config mask (an absent limit is 0, as
    /// agave's `from_v1_config` reads it).
    pub fn budget(&self) -> fclient::tx::ParsedBudget {
        match &self.d.tx.message {
            VersionedMessage::V1(m) => fclient::tx::ParsedBudget {
                cu_limit: Some(m.config.compute_unit_limit.unwrap_or(0)),
                cu_price: None,
                loaded_limit: Some(m.config.loaded_accounts_data_size_limit.unwrap_or(0)),
                heap: m.config.heap_size,
                other_ixs: m.instructions.len(),
            },
            _ => fclient::tx::parse_budget(&self.view),
        }
    }

    /// The transaction as signed (re-execution).
    pub fn versioned(&self) -> VersionedTransaction {
        self.d.tx.clone()
    }

    /// Each lookup's (table, index, address the record says it resolved
    /// to, writable), in the runtime's order of [`Msg::keys`] past the
    /// static keys.
    pub fn lookups(&self) -> Vec<(Address, u8, Address, bool)> {
        let mut out = vec![];
        let (mut w, mut r) = (self.loaded.writable.iter(), self.loaded.readonly.iter());
        let mut ro = vec![];
        for l in &self.d.lookups {
            for &i in &l.writable_indexes {
                if let Some(a) = w.next() {
                    out.push((l.account_key, i, *a, true));
                }
            }
            for &i in &l.readonly_indexes {
                ro.push((l.account_key, i));
            }
        }
        for (t, i) in ro {
            if let Some(a) = r.next() {
                out.push((t, i, *a, false));
            }
        }
        out
    }

    /// The lookup tables this transaction's lookups need, each as the
    /// address list the record's `loaded` says (index → address; indexes it
    /// does not use hold the default address). An index named twice with two
    /// different addresses is an error (no table holds both).
    pub fn tables(&self) -> Result<Vec<(Address, Vec<Address>)>, String> {
        let mut m: std::collections::BTreeMap<Address, Vec<Option<Address>>> = Default::default();
        for (t, i, a, _) in self.lookups() {
            let v = m.entry(t).or_default();
            if v.len() <= i as usize {
                v.resize(i as usize + 1, None);
            }
            match v[i as usize] {
                Some(b) if b != a => {
                    return Err(format!(
                        "loadedAddresses name {b} and {a} for index {i} of lookup table {t}"
                    ))
                }
                _ => v[i as usize] = Some(a),
            }
        }
        Ok(m.into_iter()
            .map(|(t, v)| (t, v.into_iter().map(|a| a.unwrap_or_default()).collect()))
            .collect())
    }
}

/// The address lookup table program.
pub fn lookup_table_program() -> Address {
    "AddressLookupTab1e1111111111111111111111111"
        .parse()
        .expect("the address lookup table program id")
}

/// `LOOKUP_TABLE_META_SIZE`: the table's 56-byte header (u32 state tag 1 =
/// LookupTable, deactivation slot, last extended slot, its start index,
/// `Option<authority>`, padding), then 32-byte addresses.
pub const TABLE_META: usize = 56;

/// A lookup table account's addresses (`None`: not a lookup table: wrong
/// owner, an uninitialized or malformed one).
pub fn table_addresses(owner: &Address, data: &[u8]) -> Option<Vec<Address>> {
    if *owner != lookup_table_program()
        || data.len() < TABLE_META
        || !(data.len() - TABLE_META).is_multiple_of(32)
        || data[..4] != 1u32.to_le_bytes()
    {
        return None;
    }
    Some(
        data[TABLE_META..]
            .chunks(32)
            .map(|c| Address::new_from_array(c.try_into().expect("32")))
            .collect(),
    )
}

/// The bytes of an ACTIVE lookup table holding `addresses` (never
/// deactivated, last extended at slot 0, so every address is usable at any
/// later slot): what the re-execution installs for LiteSVM to resolve a v0
/// transaction's lookups exactly as the record says the cluster did.
pub fn active_table(addresses: &[Address]) -> Vec<u8> {
    let mut d = Vec::with_capacity(TABLE_META + 32 * addresses.len());
    d.extend_from_slice(&1u32.to_le_bytes());
    d.extend_from_slice(&u64::MAX.to_le_bytes()); // deactivation slot
    d.extend_from_slice(&0u64.to_le_bytes()); // last extended slot
    d.push(0); // its start index
    d.push(0); // authority: None (frozen)
    d.extend_from_slice(&[0u8; 32]);
    d.extend_from_slice(&[0u8; 2]);
    debug_assert_eq!(d.len(), TABLE_META);
    for a in addresses {
        d.extend_from_slice(a.as_ref());
    }
    d
}
