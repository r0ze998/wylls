//! 06's canonical JSON (`workstreams/06-creation/src/canonical.mjs`),
//! re-derived so 11 can recompute a content hash without running 06's code:
//!
//! - object keys sorted as JavaScript's default sort does: by UTF-16 code
//!   units (not by bytes or chars; they differ above U+FFFF);
//! - no whitespace; strings as `JSON.stringify` writes them;
//! - numbers only as safe integers (|n| ≤ 2^53 − 1), printed in decimal;
//!   `-0` prints `0`, `1e2` and `100.0` print `100` (JavaScript reads them as
//!   the same number);
//! - nesting deeper than 32 is refused.
//!
//! Duplicate keys: `JSON.parse` and serde_json both keep the last one, so
//! the two sides hash the same object.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::BridgeError;

pub const MAX_DEPTH: usize = 32;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn number(n: &serde_json::Number, path: &str) -> Result<String, BridgeError> {
    let refuse = || BridgeError::NotSafeInteger(path.to_string());
    if let Some(i) = n.as_i64() {
        if (i as i128).abs() > MAX_SAFE as i128 {
            return Err(refuse());
        }
        return Ok(i.to_string());
    }
    if let Some(u) = n.as_u64() {
        // Above i64::MAX, so above 2^53 − 1.
        let _ = u;
        return Err(refuse());
    }
    let f = n.as_f64().ok_or_else(refuse)?;
    if !f.is_finite() || f.fract() != 0.0 || f.abs() > MAX_SAFE {
        return Err(refuse());
    }
    // -0 is a safe integer in JavaScript and prints "0".
    Ok((f as i64).to_string())
}

/// `JSON.stringify(s)` for a well-formed string.
fn string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn utf16_key(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn write(v: &Value, path: &str, depth: usize, out: &mut String) -> Result<(), BridgeError> {
    if depth > MAX_DEPTH {
        return Err(BridgeError::TooDeep);
    }
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n, path)?),
        Value::String(s) => string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, &format!("{path}[{i}]"), depth + 1, out)?;
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by_key(|k| utf16_key(k));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                string(k, out);
                out.push(':');
                write(&o[*k], &format!("{path}.{k}"), depth + 1, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// The canonical form 06 hashes.
pub fn canonicalize(v: &Value) -> Result<String, BridgeError> {
    let mut out = String::new();
    write(v, "$", 0, &mut out)?;
    Ok(out)
}

/// 06's content hash: SHA-256 of the canonical form, lowercase hex.
pub fn content_hash(v: &Value) -> Result<String, BridgeError> {
    let c = canonicalize(v)?;
    Ok(crate::hex(&Sha256::digest(c.as_bytes())))
}
