//! 06's signed messages (`src/keys.mjs`, `src/registry.mjs`): Ed25519 over
//! `domain ‖ 0x00 ‖ hash`, where `hash` is the **lowercase hex text** of the
//! content hash (not its bytes). Domains separate the roles, so a
//! publication signature never verifies as a status change.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};

use crate::canonical::content_hash;
use crate::{from_hex, BridgeError};

pub const PUBLISH: &str = "wylls.creation.publish/0";
pub const STATUS: &str = "wylls.creation.status/0";

/// The message 06 signs.
pub fn message(domain: &str, hash_hex: &str) -> Vec<u8> {
    let mut m = domain.as_bytes().to_vec();
    m.push(0);
    m.extend_from_slice(hash_hex.as_bytes());
    m
}

/// Whether `sig_hex` is `pub_hex`'s signature of `domain ‖ 0 ‖ hash_hex`.
pub fn verify(pub_hex: &str, domain: &str, hash_hex: &str, sig_hex: &str) -> bool {
    let (Some(pk), Some(sig)) = (from_hex(pub_hex), from_hex(sig_hex)) else {
        return false;
    };
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk), <[u8; 64]>::try_from(sig)) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else {
        return false;
    };
    key.verify(&message(domain, hash_hex), &Signature::from_bytes(&sig))
        .is_ok()
}

/// What a checked envelope establishes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publication {
    pub author: String,
    pub name: String,
    pub version: String,
    pub hash: String,
}

fn str_field<'a>(v: &'a Value, k: &str) -> Result<&'a str, BridgeError> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::Shape(format!("{k} is not a string")))
}

/// `{manifest, hash, signature}`: the hash is the manifest's, and the
/// manifest's author signed it in the publication domain.
pub fn verify_envelope(env: &Value) -> Result<Publication, BridgeError> {
    let m = env
        .get("manifest")
        .filter(|m| m.is_object())
        .ok_or_else(|| BridgeError::Shape("an envelope is {manifest, hash, signature}".into()))?;
    let actual = content_hash(m)?;
    let claimed = str_field(env, "hash")?;
    if claimed != actual {
        return Err(BridgeError::HashMismatch {
            claimed: claimed.into(),
            actual,
        });
    }
    let author = str_field(m, "author")?;
    let sig = str_field(env, "signature")?;
    if !verify(author, PUBLISH, &actual, sig) {
        return Err(BridgeError::SignatureInvalid);
    }
    Ok(Publication {
        author: author.into(),
        name: str_field(m, "name")?.into(),
        version: str_field(m, "version")?.into(),
        hash: actual,
    })
}

/// The hash a status change is signed over (06's `statusMessage`).
pub fn status_message(
    author: &str,
    name: &str,
    status: &str,
    seq: u64,
) -> Result<String, BridgeError> {
    content_hash(&json!({ "author": author, "name": name, "status": status, "seq": seq }))
}
