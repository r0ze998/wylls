//! Default-off, read-only same-response account snapshots.
//!
//! All requested accounts, Clock and optional Rent come from one RPC response.
//! Sealed metadata binds their contents and requested/context slots. Coherence
//! is not currency, authority, completeness or permission. Consumers that copy
//! or mutate the returned data must verify it with `SnapshotMeta::verify`.
//!
//! This module has no planner, signing or startup hooks. Transport runs only
//! when a caller explicitly awaits `SnapshotPort::snapshot`.

use std::collections::BTreeMap;
use std::future::Future;

use crate::ports::{Account, ClockSysvar};
use crate::rpc::{parse_account, RpcPort};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

/// `getMultipleAccounts` accepts at most 100 keys; the Clock and the Rent
/// sysvars take two of them.
pub const MAX_SNAPSHOT_KEYS: usize = 98;
/// The commitment every snapshot is requested at.
pub const COMMITMENT: &str = "confirmed";
/// The runtime's per-account storage overhead counted by `minimum_balance`.
pub const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;
/// The program's solana-rent 4.4 maximum account data length (10 MiB).
const MAX_RENT_DATA_LENGTH: usize = 10 * 1024 * 1024;
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

    /// The **full** minimum an account of `space` bytes must hold, whatever
    /// the address already holds. Matches the program's solana-rent 4.4
    /// integer paths and global rate bounds for thresholds 1.0 and 2.0;
    /// returns `None` above the runtime's maximum account size. Other
    /// thresholds retain the conservative checked, truncated float path:
    /// overflow and non-finite/negative results refuse, never saturate.
    pub fn minimum_balance(&self, space: usize) -> Option<u64> {
        if space > MAX_RENT_DATA_LENGTH {
            return None;
        }
        let bytes = ACCOUNT_STORAGE_OVERHEAD.checked_add(u64::try_from(space).ok()?)?;
        let multiplier = if self.exemption_threshold == 1.0 {
            Some(1)
        } else if self.exemption_threshold == 2.0 {
            Some(2)
        } else {
            None
        };
        if let Some(multiplier) = multiplier {
            // The runtime validates against its largest permitted account,
            // even when this particular account's product would fit.
            let max_bytes = MAX_RENT_DATA_LENGTH as u64 + ACCOUNT_STORAGE_OVERHEAD;
            if self.lamports_per_byte_year > u64::MAX / max_bytes / multiplier {
                return None;
            }
            return bytes
                .checked_mul(self.lamports_per_byte_year)?
                .checked_mul(multiplier);
        }
        let per_year = bytes.checked_mul(self.lamports_per_byte_year)?;
        let v = per_year as f64 * self.exemption_threshold;
        if !v.is_finite() || v < 0.0 || v >= u64::MAX as f64 {
            return None;
        }
        Some(v as u64)
    }
}

#[cfg(test)]
mod rent_math_tests {
    use super::RentSysvar;

    // Literal solana-rent 4.4 limits, independent of the production constants.
    const MAX_SPACE: usize = 10_485_760;
    const MAX_RATE_ONE: u64 = 1_759_197_129_867;
    const MAX_RATE_TWO: u64 = 879_598_564_933;

    fn rent(rate: u64, threshold: f64) -> RentSysvar {
        RentSysvar {
            lamports_per_byte_year: rate,
            exemption_threshold: threshold,
            burn_percent: 50,
        }
    }

    #[test]
    fn standard_thresholds_keep_ordinary_minima() {
        for (space, expected) in [(0, 890_880), (1, 897_840), (128, 1_781_760)] {
            assert_eq!(rent(6_960, 1.0).minimum_balance(space), Some(expected));
            assert_eq!(rent(3_480, 2.0).minimum_balance(space), Some(expected));
        }
    }

    #[test]
    fn standard_thresholds_preserve_integer_precision_above_f64_range() {
        // The per-year product is odd and above 2^53. Casting it to f64
        // before applying either threshold loses a lamport (two for 2.0).
        assert_eq!(
            rent(1_073_741_825, 1.0).minimum_balance(8_388_609),
            Some(9_007_337_775_825_025)
        );
        assert_eq!(
            rent(1_073_741_825, 2.0).minimum_balance(8_388_609),
            Some(18_014_675_551_650_050)
        );
    }

    #[test]
    fn standard_thresholds_accept_exact_rate_limits_at_maximum_space() {
        for (threshold, rate, multiplier) in
            [(1.0, MAX_RATE_ONE, 1u128), (2.0, MAX_RATE_TWO, 2u128)]
        {
            for space in [0, 1, MAX_SPACE - 1, MAX_SPACE] {
                let expected = u64::try_from((space as u128 + 128) * rate as u128 * multiplier)
                    .expect("literal runtime limits fit u64");
                assert_eq!(rent(rate, threshold).minimum_balance(space), Some(expected));
                if space >= MAX_SPACE - 1 {
                    assert!(expected > i64::MAX as u64);
                }
            }
        }
    }

    #[test]
    fn standard_thresholds_reject_global_rate_overflow_even_for_empty_account() {
        for (threshold, max_rate) in [(1.0, MAX_RATE_ONE), (2.0, MAX_RATE_TWO)] {
            for rate in [max_rate + 1, u64::MAX] {
                for space in [0, 1, MAX_SPACE] {
                    assert_eq!(rent(rate, threshold).minimum_balance(space), None);
                }
            }
        }
    }

    #[test]
    fn every_threshold_rejects_oversized_accounts_even_at_zero_rate() {
        for threshold in [0.0, 0.5, 1.0, 1.5, 2.0, 3.0] {
            assert_eq!(rent(0, threshold).minimum_balance(MAX_SPACE), Some(0));
            for space in [MAX_SPACE + 1, usize::MAX] {
                assert_eq!(rent(0, threshold).minimum_balance(space), None);
                assert_eq!(rent(1, threshold).minimum_balance(space), None);
            }
        }
    }

    #[test]
    fn nonstandard_thresholds_keep_checked_truncated_float_fallback() {
        assert_eq!(rent(1, 0.5).minimum_balance(1), Some(64));
        assert_eq!(rent(1, 1.5).minimum_balance(1), Some(193));
        assert_eq!(rent(1, 0.0).minimum_balance(1), Some(0));
        assert_eq!(rent(1, -0.0).minimum_balance(1), Some(0));
        // The runtime's standard-threshold rate limits do not apply here.
        assert_eq!(
            rent(MAX_RATE_ONE + 1, 0.5).minimum_balance(0),
            Some(112_588_616_311_552)
        );
        // Keep rejecting an overflowing integer intermediate, even when a
        // zero threshold could otherwise erase it. Do not adopt saturation.
        assert_eq!(rent(u64::MAX, 0.0).minimum_balance(0), None);
        assert_eq!(rent(u64::MAX / 128, 0.5).minimum_balance(1), None);
        assert_eq!(rent(u64::MAX / 128, 3.0).minimum_balance(0), None);
        assert_eq!(rent(u64::MAX / 128, 1.5).minimum_balance(0), None);
    }

    #[test]
    fn invalid_float_results_still_refuse_without_panicking() {
        for threshold in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, f64::MAX] {
            assert_eq!(rent(1, threshold).minimum_balance(0), None);
        }
        // The existing exclusive bound also rejects a finite f64 equal to
        // 2^64, rather than relying on Rust's saturating float-to-int cast.
        assert_eq!(rent(1, (u64::MAX as f64) / 128.0).minimum_balance(0), None);
    }

    #[test]
    fn arithmetic_refusal_does_not_change_rent_wire_decoding() {
        for threshold in [1.0, 2.0] {
            let value = rent(u64::MAX, threshold);
            let encoded = value.encode();
            let decoded = RentSysvar::decode(&encoded).expect("finite Rent fields still decode");
            assert_eq!(decoded, value);
            assert_eq!(decoded.encode(), encoded);
            assert_eq!(decoded.minimum_balance(0), None);
        }
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

impl SnapshotError {
    /// A bounded, typed code for status output: the variant and its
    /// numeric or static-string payload, **never** the RPC's own text
    /// (which may carry a URL with credentials or arbitrary server
    /// output).
    pub fn code(&self) -> String {
        match self {
            SnapshotError::Unsupported => "Unsupported".into(),
            SnapshotError::TooManyKeys { n, max } => format!("TooManyKeys({n},{max})"),
            SnapshotError::DuplicateKey => "DuplicateKey".into(),
            SnapshotError::Rpc(_) => "Rpc".into(),
            SnapshotError::Malformed(w) => format!("Malformed({w})"),
            SnapshotError::Partial { want, got } => format!("Partial({want},{got})"),
            SnapshotError::Stale {
                context_slot,
                min_slot,
            } => format!("Stale({context_slot},{min_slot})"),
            SnapshotError::BadClock(w) => format!("BadClock({w})"),
            SnapshotError::BadRent(w) => format!("BadRent({w})"),
        }
    }
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
/// Read through immutable accessors; adapters may copy values for their consumers.
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
            ks.push(crate::addr::clock_sysvar().to_string());
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

/// The **object-safe** form of [`SnapshotPort`], so a runtime generic over
/// `crate::ports::ChainPort` alone can carry the snapshot as an **additive, optional**
/// adapter (`Box<dyn SnapshotSource>`) without a new bound on every port
/// implementation. Every `SnapshotPort` is a `SnapshotSource` (blanket
/// impl); the JSON-RPC port is one, a fake port in a test is one,
/// a port without the capability answers `Unsupported`.
pub trait SnapshotSource: Send + Sync {
    /// [`SnapshotPort::snapshot`], boxed.
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        with_rent: bool,
        min_slot: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>>;

    /// A label for status output: what the source is, never where (no URL,
    /// no secret).
    fn label(&self) -> &'static str {
        "SnapshotPort: one getMultipleAccounts with minContextSlot, parsed by parse_snapshot_response"
    }
}

impl<T: SnapshotPort + Send + Sync> SnapshotSource for T {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        with_rent: bool,
        min_slot: u64,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        Box::pin(SnapshotPort::snapshot(self, keys, with_rent, min_slot))
    }
}
