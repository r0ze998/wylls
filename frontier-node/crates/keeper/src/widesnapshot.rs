//! **Read-only, opt-in** (feature `wide-world-experimental`): a
//! **same-response account snapshot** for the wide planners, with sealed
//! provenance.
//!
//! `ChainPort::accounts(keys, min_slot)` returns no context: the planners'
//! `Reads` are a lower bound and the Clock a separate call, which is why a
//! candidate planned over them is not coherent. This module adds an
//! **additive** capability, [`SnapshotPort`], whose default is
//! `Unsupported`: a port that can return **all** requested keys, the Clock
//! sysvar and (when asked) the Rent sysvar in **one** `getMultipleAccounts`
//! response at or past a requested minimum slot, with the response's exact
//! `context.slot`, implements it. The JSON-RPC port does; every other
//! `ChainPort` keeps its existing behaviour.
//!
//! **Provenance is sealed and re-verified.** A [`SnapshotMeta`] is built
//! only by [`parse_snapshot_response`] and carries a digest over the whole
//! response — the requested and context slots, the commitment, every key
//! with its presence, lamports, owner, executable flag and data, the Clock
//! bytes and the Rent bytes. The [`Snapshot`] keeps its contents behind
//! accessors. The planners' public `Reads` may be mutated for
//! compatibility, but **every** consumer re-verifies the digest over the
//! reads it is actually given (`Reads::coherent_snapshot`): a meta cloned
//! onto other bytes, a changed `min_slot`, a swapped clock or rent, an
//! added or removed account all make the reads non-coherent. Same-response
//! data is coherence at the response's context slot — not authority, not
//! currency, not source completeness, and not permission.
//!
//! **Response validation.** One request, never chunked; at most
//! [`MAX_SNAPSHOT_KEYS`] distinct keys (`TooManyKeys`, `DuplicateKey`); the
//! entry count exactly the request's (`Partial`); `context.slot` present
//! and at or past the requested minimum (`Stale`); the Clock and the Rent
//! entries present, owned by the sysvar owner, non-executable, of exactly
//! the sysvar's length, decodable, and the Clock's own `slot` equal to the
//! context slot (`BadClock`, `BadRent`).

use std::collections::BTreeMap;
use std::future::Future;

use fclient::ports::{Account, ChainPort, ClockSysvar};
use fclient::rpc::{parse_account, RpcPort};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

use crate::wideduty::{Block, Reads, Step};

/// `getMultipleAccounts` accepts at most 100 keys; the Clock and the Rent
/// sysvars take two of them.
pub const MAX_SNAPSHOT_KEYS: usize = 98;
/// The commitment every snapshot is requested at.
pub const COMMITMENT: &str = "confirmed";
/// The runtime's per-account storage overhead counted by `minimum_balance`.
pub const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;
/// The Clock sysvar's data length.
pub const CLOCK_LEN: usize = 40;
/// The Rent sysvar's data length.
pub const RENT_LEN: usize = 17;
const DIGEST_DOMAIN: &[u8] = b"PSF-KEEPER-WIDE-SNAPSHOT-v1";

/// The owner of every sysvar account.
pub fn sysvar_owner() -> Address {
    "Sysvar1111111111111111111111111111111111111"
        .parse()
        .expect("the sysvar owner is a constant")
}

/// The Rent sysvar's address.
pub fn rent_sysvar() -> Address {
    "SysvarRent111111111111111111111111111111111"
        .parse()
        .expect("the Rent sysvar address is a constant")
}

/// The Rent sysvar as the runtime serialises it: `lamports_per_byte_year
/// u64 ‖ exemption_threshold f64 ‖ burn_percent u8` (17 bytes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RentSysvar {
    pub lamports_per_byte_year: u64,
    pub exemption_threshold: f64,
    pub burn_percent: u8,
}

impl RentSysvar {
    /// Exactly 17 bytes, a finite non-negative threshold.
    pub fn decode(d: &[u8]) -> Option<RentSysvar> {
        if d.len() != RENT_LEN {
            return None;
        }
        let lamports_per_byte_year = u64::from_le_bytes(d[0..8].try_into().ok()?);
        let exemption_threshold = f64::from_le_bytes(d[8..16].try_into().ok()?);
        if !exemption_threshold.is_finite() || exemption_threshold < 0.0 {
            return None;
        }
        Some(RentSysvar {
            lamports_per_byte_year,
            exemption_threshold,
            burn_percent: d[16],
        })
    }

    pub fn encode(&self) -> [u8; RENT_LEN] {
        let mut d = [0u8; RENT_LEN];
        d[0..8].copy_from_slice(&self.lamports_per_byte_year.to_le_bytes());
        d[8..16].copy_from_slice(&self.exemption_threshold.to_le_bytes());
        d[16] = self.burn_percent;
        d
    }

    /// The runtime's `Rent::minimum_balance`: `((128 + space) ×
    /// lamports_per_byte_year) × exemption_threshold`, truncated — the
    /// **full** minimum an account of `space` bytes must hold, whatever the
    /// address already holds. `None` on overflow.
    pub fn minimum_balance(&self, space: usize) -> Option<u64> {
        let bytes = ACCOUNT_STORAGE_OVERHEAD.checked_add(u64::try_from(space).ok()?)?;
        let per_year = bytes.checked_mul(self.lamports_per_byte_year)?;
        let v = per_year as f64 * self.exemption_threshold;
        if !v.is_finite() || v < 0.0 || v >= u64::MAX as f64 {
            return None;
        }
        Some(v as u64)
    }
}

/// Why no snapshot was taken.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotError {
    /// The port cannot report a response context (the default).
    Unsupported,
    TooManyKeys {
        n: usize,
        max: usize,
    },
    /// A key requested twice (the response could not be bound to keys).
    DuplicateKey,
    /// The RPC call failed.
    Rpc(String),
    /// The response is not one complete `getMultipleAccounts` result.
    Malformed(&'static str),
    /// The response holds another number of entries than requested.
    Partial {
        want: usize,
        got: usize,
    },
    /// The response's context slot is below the requested minimum.
    Stale {
        context_slot: u64,
        min_slot: u64,
    },
    /// The Clock entry is absent, foreign-owned, executable, of another
    /// length, undecodable, or its slot is not the context slot.
    BadClock(&'static str),
    /// The Rent entry was requested and is absent, foreign-owned,
    /// executable, of another length or undecodable.
    BadRent(&'static str),
}

/// The sealed facts of one response. Constructed only by
/// [`parse_snapshot_response`]; read through methods; re-verified against
/// the reads it is attached to by [`SnapshotMeta::verify`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotMeta {
    context_slot: u64,
    min_slot: u64,
    commitment: &'static str,
    keys: usize,
    rent_included: bool,
    digest: [u8; 32],
}

/// The digest over a response's whole content.
fn digest_of(
    context_slot: u64,
    min_slot: u64,
    commitment: &str,
    accounts: &BTreeMap<Address, Option<Account>>,
    clock: &ClockSysvar,
    rent: Option<&RentSysvar>,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DIGEST_DOMAIN);
    h.update(context_slot.to_le_bytes());
    h.update(min_slot.to_le_bytes());
    h.update((commitment.len() as u32).to_le_bytes());
    h.update(commitment.as_bytes());
    h.update((accounts.len() as u32).to_le_bytes());
    for (k, a) in accounts {
        h.update(k.to_bytes());
        match a {
            None => h.update([0u8]),
            Some(a) => {
                h.update([1u8]);
                h.update(a.lamports.to_le_bytes());
                h.update(a.owner.to_bytes());
                h.update([a.executable as u8]);
                h.update((a.data.len() as u32).to_le_bytes());
                h.update(&a.data);
            }
        }
    }
    h.update([0xC1u8]);
    h.update(clock.encode());
    match rent {
        None => h.update([0u8]),
        Some(r) => {
            h.update([1u8]);
            h.update(r.encode());
        }
    }
    h.finalize().into()
}

impl SnapshotMeta {
    /// The `context.slot` the RPC served the response at: the slot the
    /// accounts and the Clock are coherent at, not proof of currency.
    pub fn context_slot(&self) -> u64 {
        self.context_slot
    }
    /// The minimum slot the request asked for (`minContextSlot`).
    pub fn min_slot(&self) -> u64 {
        self.min_slot
    }
    pub fn commitment(&self) -> &'static str {
        self.commitment
    }
    /// The number of caller keys in the response (sysvars excluded).
    pub fn keys(&self) -> usize {
        self.keys
    }
    pub fn rent_included(&self) -> bool {
        self.rent_included
    }
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }

    /// Whether these reads are exactly the response this meta was built
    /// from: the same requested slot, clock, rent and every account.
    pub fn verify(
        &self,
        min_slot: u64,
        clock: Option<&ClockSysvar>,
        rent: Option<&RentSysvar>,
        accounts: &BTreeMap<Address, Option<Account>>,
    ) -> bool {
        let Some(clock) = clock else {
            return false;
        };
        if accounts.len() != self.keys
            || min_slot != self.min_slot
            || rent.is_some() != self.rent_included
            || clock.slot != self.context_slot
        {
            return false;
        }
        digest_of(
            self.context_slot,
            self.min_slot,
            self.commitment,
            accounts,
            clock,
            rent,
        ) == self.digest
    }

    pub fn describe(&self) -> Value {
        json!({
            "context_slot": self.context_slot,
            "min_slot": self.min_slot,
            "commitment": self.commitment,
            "keys": self.keys,
            "rent_included": self.rent_included,
            "digest": hex::encode(self.digest),
            "single_response": true,
            "current": "unknown",
            "source_complete": false,
            "authority": "none: coherence at the context slot only",
        })
    }
}

/// One response: the caller's accounts, the Clock, the Rent when asked.
/// Read through the accessors; the planners take it as [`Snapshot::reads`].
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    meta: SnapshotMeta,
    accounts: BTreeMap<Address, Option<Account>>,
    clock: ClockSysvar,
    rent: Option<RentSysvar>,
}

impl Snapshot {
    pub fn meta(&self) -> &SnapshotMeta {
        &self.meta
    }
    pub fn accounts(&self) -> &BTreeMap<Address, Option<Account>> {
        &self.accounts
    }
    pub fn clock(&self) -> ClockSysvar {
        self.clock
    }
    pub fn rent(&self) -> Option<RentSysvar> {
        self.rent
    }

    /// The planners' reads over this one response: the accounts, the
    /// Clock and the Rent from the same response, the requested minimum
    /// slot, and the sealed meta (re-verified by every consumer).
    pub fn reads(&self) -> Reads {
        Reads {
            min_slot: self.meta.min_slot,
            clock: Some(self.clock),
            accounts: self.accounts.clone(),
            snapshot: Some(self.meta.clone()),
            rent: self.rent,
        }
    }
}

/// A sysvar entry: present, owned by the sysvar owner, not executable
/// (the JSON must say `"executable": false` explicitly — the generic
/// account parser defaults a missing or non-boolean field to `false`), of
/// exactly `len` bytes.
fn sysvar_entry(
    v: &Value,
    len: usize,
    bad: fn(&'static str) -> SnapshotError,
) -> Result<Vec<u8>, SnapshotError> {
    if v.is_null() {
        return Err(bad("absent"));
    }
    if v.get("executable").and_then(Value::as_bool) != Some(false) {
        return Err(bad("executable"));
    }
    let acc = parse_account(v)
        .map_err(|_| bad("entry does not parse"))?
        .ok_or(bad("absent"))?;
    if acc.owner != sysvar_owner() {
        return Err(bad("not owned by the sysvar owner"));
    }
    if acc.executable {
        return Err(bad("executable"));
    }
    if acc.data.len() != len {
        return Err(bad("length"));
    }
    Ok(acc.data)
}

/// Parses one `getMultipleAccounts` result `{context: {slot}, value: [..]}`
/// requested for `keys ‖ Clock (‖ Rent)` at `min_slot`. Pure; the RPC port
/// calls it and a test can feed it literal JSON.
pub fn parse_snapshot_response(
    v: &Value,
    keys: &[Address],
    with_rent: bool,
    min_slot: u64,
) -> Result<Snapshot, SnapshotError> {
    if keys.len() > MAX_SNAPSHOT_KEYS {
        return Err(SnapshotError::TooManyKeys {
            n: keys.len(),
            max: MAX_SNAPSHOT_KEYS,
        });
    }
    for (i, k) in keys.iter().enumerate() {
        if keys[..i].contains(k) {
            return Err(SnapshotError::DuplicateKey);
        }
    }
    let context_slot = v
        .get("context")
        .and_then(|c| c.get("slot"))
        .and_then(Value::as_u64)
        .ok_or(SnapshotError::Malformed("no context.slot"))?;
    if context_slot < min_slot {
        return Err(SnapshotError::Stale {
            context_slot,
            min_slot,
        });
    }
    let arr = v
        .get("value")
        .and_then(Value::as_array)
        .ok_or(SnapshotError::Malformed("no value array"))?;
    let want = keys.len() + 1 + usize::from(with_rent);
    if arr.len() != want {
        return Err(SnapshotError::Partial {
            want,
            got: arr.len(),
        });
    }
    let mut accounts = BTreeMap::new();
    for (k, a) in keys.iter().zip(arr.iter()) {
        let acc = parse_account(a).map_err(|_| SnapshotError::Malformed("account entry"))?;
        accounts.insert(*k, acc);
    }
    let clock_data = sysvar_entry(&arr[keys.len()], CLOCK_LEN, SnapshotError::BadClock)?;
    let clock = ClockSysvar::decode(&clock_data).ok_or(SnapshotError::BadClock("decode"))?;
    if clock.slot != context_slot {
        return Err(SnapshotError::BadClock(
            "slot differs from the context slot",
        ));
    }
    let rent = if with_rent {
        let d = sysvar_entry(&arr[keys.len() + 1], RENT_LEN, SnapshotError::BadRent)?;
        Some(RentSysvar::decode(&d).ok_or(SnapshotError::BadRent("decode"))?)
    } else {
        None
    };
    let digest = digest_of(
        context_slot,
        min_slot,
        COMMITMENT,
        &accounts,
        &clock,
        rent.as_ref(),
    );
    Ok(Snapshot {
        meta: SnapshotMeta {
            context_slot,
            min_slot,
            commitment: COMMITMENT,
            keys: keys.len(),
            rent_included: with_rent,
            digest,
        },
        accounts,
        clock,
        rent,
    })
}

/// The additive capability. The default cannot report a context and says
/// so; nothing else about a port changes.
pub trait SnapshotPort {
    /// All of `keys`, the Clock and (when `with_rent`) the Rent in one
    /// response at or past `min_slot`, with its context slot.
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        let _ = (keys, with_rent, min_slot);
        async { Err(SnapshotError::Unsupported) }
    }
}

impl SnapshotPort for RpcPort {
    fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> impl Future<Output = Result<Snapshot, SnapshotError>> + Send {
        let keys: Vec<Address> = keys.to_vec();
        async move {
            if keys.len() > MAX_SNAPSHOT_KEYS {
                return Err(SnapshotError::TooManyKeys {
                    n: keys.len(),
                    max: MAX_SNAPSHOT_KEYS,
                });
            }
            let mut ks: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
            ks.push(fclient::addr::clock_sysvar().to_string());
            if with_rent {
                ks.push(rent_sysvar().to_string());
            }
            let mut cfg = json!({"encoding": "base64", "commitment": COMMITMENT});
            if min_slot > 0 {
                cfg["minContextSlot"] = json!(min_slot);
            }
            // One request; the response is bound to the request's keys.
            let v = self
                .rpc
                .call("getMultipleAccounts", json!([ks, cfg]))
                .await
                .map_err(|e| SnapshotError::Rpc(e.to_string()))?;
            parse_snapshot_response(&v, &keys, with_rent, min_slot)
        }
    }
}

/// Plans over one snapshot. First the key set is learned through ordinary
/// reads (non-coherent; the planner asks in rounds); then **one** snapshot
/// of every key it asked for plus `extra_keys` (a fee payer whose balance
/// the fee review bounds) is taken at or past `min_slot`; then the plan
/// runs again over that response alone. A plan that asks for a key the
/// snapshot does not hold (the state moved between the two) is
/// `Block::SnapshotIncomplete`, never patched from another read.
pub async fn snapshot_plan<P, T, F>(
    port: &P,
    min_slot: u64,
    with_rent: bool,
    extra_keys: &[Address],
    mut plan: F,
) -> Result<(T, Snapshot), Block>
where
    P: ChainPort + SnapshotPort,
    F: FnMut(&Reads) -> Step<T>,
{
    // 1. learn the keys (ordinary reads, lower bound, separate clock).
    let mut reads = Reads::new(min_slot);
    reads.clock = port.clock().await.ok();
    let mut rounds = 0;
    loop {
        rounds += 1;
        if rounds > 6 {
            return Err(Block::ReadLoop);
        }
        match plan(&reads) {
            Step::Done(Err(b)) => return Err(b),
            Step::Done(Ok(_)) => break,
            Step::Need(addrs) => {
                let got = port
                    .accounts(&addrs, min_slot)
                    .await
                    .map_err(|e| Block::Read(e.to_string()))?;
                if got.len() != addrs.len() {
                    return Err(Block::Read("account count differs from the request".into()));
                }
                for (a, acc) in addrs.iter().zip(got) {
                    reads.accounts.insert(*a, acc);
                }
            }
        }
    }
    // 2. one response for every key.
    let mut keys: Vec<Address> = reads.accounts.keys().copied().collect();
    for k in extra_keys {
        if !keys.contains(k) {
            keys.push(*k);
        }
    }
    let snap = port
        .snapshot(&keys, with_rent, min_slot)
        .await
        .map_err(|e| Block::Snapshot(format!("{e:?}")))?;
    // 3. the plan over that response alone.
    match plan(&snap.reads()) {
        Step::Done(Ok(t)) => Ok((t, snap)),
        Step::Done(Err(b)) => Err(b),
        Step::Need(addrs) => Err(Block::SnapshotIncomplete(addrs.len())),
    }
}
