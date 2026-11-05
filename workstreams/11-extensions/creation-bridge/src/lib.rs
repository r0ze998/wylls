//! Workstream 11's side of the boundary with workstream 06 (creation,
//! publication, reuse), as of 06's commit `517796dc`.
//!
//! **Who does what.** 06 registers definitions, pins versions (a plan names
//! `{author, name, version, hash}`) and publishes each entry's status
//! (listed / suspended / withdrawn). 11 keeps **no registry of 06's
//! definitions**: this crate only *reads* 06's export and checks, at run
//! time, that what a plan pins is exactly what 06 published. The status
//! 06 publishes is reported with 06's own meaning (it stops new adoptions,
//! never a pinned plan) and is a different type from 11's execution status
//! (`wylls_ext_kernel::registry::Status`); there is no conversion between
//! the two.
//!
//! - [`canonical`]: 06's canonical JSON and content hash, re-derived.
//! - [`envelope`]: a publication envelope `{manifest, hash, signature}`.
//! - [`registry`]: 06's registry export, checked, and pinned references.
//! - [`map`]: the fields that mean the same thing on both sides, and the
//!   ones that do not (refused, never approximated).

pub mod canonical;
pub mod envelope;
pub mod map;
pub mod registry;

use core::fmt;

/// Why something read from 06 was not accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeError {
    /// Not the JSON shape 06 writes (`what` says which part).
    Shape(String),
    /// A number 06's canonical form refuses (not a safe integer).
    NotSafeInteger(String),
    /// Nested deeper than 06's limit (32).
    TooDeep,
    /// The claimed hash is not the content's.
    HashMismatch { claimed: String, actual: String },
    /// The author's signature does not verify.
    SignatureInvalid,
    /// The registry's status log disagrees with itself or with the entry.
    StatusLog(String),
    /// No entry or version for a pinned reference.
    NotFound,
    /// The version exists, with another hash than the one pinned.
    PinMismatch { pinned: String, published: String },
    /// A field of one side that has no counterpart of the same meaning.
    NotMappable { field: String, reason: String },
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Lowercase hex only, as 06 writes it (`fromHex` refuses anything else).
pub(crate) fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0
        || !s
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
