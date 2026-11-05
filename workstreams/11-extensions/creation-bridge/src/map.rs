//! The parts of 06's definition and 11's manifest that mean the same thing,
//! mapped exactly, and every other part refused with its reason. Nothing is
//! approximated: a field without a counterpart of the same meaning is a
//! `NotMappable`, never a nearest guess.
//!
//! | 06 (`wylls.creation.manifest/0`) | 11 (`WXM1`) | here |
//! |---|---|---|
//! | `author` (Ed25519 public key, hex) | `author` (32 bytes) | [`author_key`]: same key |
//! | `params.*` of type `int` (`0 ≤ min ≤ v ≤ max`, safe integers) | an entry's `ArgSpec {min, max}` | [`int_param`] |
//! | goods `{food…influence: n}` (whole units) | resources in milli, core order | [`goods_milli`]: the core's own `cargo_bytes` / `cargo_milli` |
//! | `trigger: "manual"` | every 11 call is a signed, manual call | [`check_trigger`] |
//! | `steps[].effect` (existing commands: `caravan.send`, …) | none: effect set 1 has no command op | refused |
//! | `limits.runsPerDay` (accepted starts per day) | none: a grant's `calls_left` is a total | refused |
//! | `validUntilDay` (the author's) | none: a grant's `expires_ts` is the user's | refused |
//! | `params.*` of a place, grant or result type | none | refused |
//! | publication status (listed/suspended/withdrawn) | execution status (Active/Paused/Revoked) | not converted (`registry`) |
//! | content hash (canonical JSON) / `manifest_id` (canonical bytes) | — | different identities; a cross-reference is 06's decision |
//!
//! And 11 → 06: every 11 op (`Pay`, `Refund`, `Burn`, fields) is a new
//! world effect, 06's case D (`EFFECT_UNKNOWN`): [`eleven_to_creation`]
//! refuses all of them.

use serde_json::Value;
use wylls_ext_kernel::manifest::{ArgSpec, Manifest};

use crate::{from_hex, BridgeError};

/// 06's resource names in the core's store order. Index 4 is the store
/// the core names `Resource::Horses`, which S1 uses for arms
/// (`permutation_rules::frontier::arms::ARMS`).
pub const RESOURCES: [&str; 8] = [
    "food",
    "wood",
    "stone",
    "ore",
    "arms",
    "gold",
    "science",
    "influence",
];

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn refuse(field: impl Into<String>, reason: impl Into<String>) -> BridgeError {
    BridgeError::NotMappable {
        field: field.into(),
        reason: reason.into(),
    }
}

/// 06's author key as 11's author bytes (the same Ed25519 public key).
pub fn author_key(manifest: &Value) -> Result<[u8; 32], BridgeError> {
    let a = manifest
        .get("author")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::Shape("author is not a string".into()))?;
    from_hex(a)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| BridgeError::Shape("author is not a 32-byte hex key".into()))
}

/// One of 06's `params`: an `int` maps to 11's argument bounds with 06's
/// defaults (`min` 0, `max` unbounded, i.e. the largest safe integer, since
/// 06 accepts only safe integers). A `default` is 06's form convenience:
/// 11's calls name every argument, so it is returned, not mapped.
pub fn int_param(name: &str, p: &Value) -> Result<(ArgSpec, Option<i64>), BridgeError> {
    let field = format!("params.{name}");
    let ty = p
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::Shape(format!("{field}.type")))?;
    if ty != "int" {
        return Err(refuse(
            field,
            format!("type {ty} has no 11 argument type (11 arguments are integers)"),
        ));
    }
    let bound = |k: &str, dflt: i64| -> Result<i64, BridgeError> {
        match p.get(k) {
            None => Ok(dflt),
            Some(v) => v
                .as_i64()
                .filter(|x| (0..=MAX_SAFE).contains(x))
                .ok_or_else(|| {
                    BridgeError::Shape(format!("{field}.{k}: non-negative safe integer"))
                }),
        }
    };
    let (min, max) = (bound("min", 0)?, bound("max", MAX_SAFE)?);
    if min > max {
        return Err(BridgeError::Shape(format!("{field}: min > max")));
    }
    let default = match p.get("default") {
        None => None,
        Some(v) => Some(
            v.as_i64()
                .filter(|x| (min..=max).contains(x))
                .ok_or_else(|| BridgeError::Shape(format!("{field}.default")))?,
        ),
    };
    Ok((ArgSpec { min, max }, default))
}

/// 06's goods (whole units by resource name) as the core's milli-units, by
/// the core's own conversion (whole units × 1,000, at most `u32::MAX` units
/// per resource, as SendCaravan carries them).
pub fn goods_milli(goods: &Value) -> Result<[i64; 8], BridgeError> {
    let o = goods
        .as_object()
        .ok_or_else(|| BridgeError::Shape("goods is not an object".into()))?;
    let mut units = [0u32; 8];
    for (k, v) in o {
        let r = RESOURCES
            .iter()
            .position(|n| n == k)
            .ok_or_else(|| refuse(format!("goods.{k}"), "not a core resource"))?;
        let n = v.as_u64().ok_or_else(|| {
            refuse(
                format!("goods.{k}"),
                "an amount must be a literal non-negative integer",
            )
        })?;
        units[r] = u32::try_from(n).map_err(|_| {
            refuse(
                format!("goods.{k}"),
                "more units than a caravan's cargo field holds",
            )
        })?;
    }
    let bytes = frontier_abi::v2::ix::cargo_bytes(&units);
    frontier_abi::v2::ix::cargo_milli(&bytes).ok_or_else(|| refuse("goods", "overflow"))
}

/// `trigger`: only `manual` (absent means manual in 06) has a counterpart.
pub fn check_trigger(manifest: &Value) -> Result<(), BridgeError> {
    match manifest.get("trigger").and_then(Value::as_str) {
        None | Some("manual") => Ok(()),
        Some(t) => Err(refuse(
            "trigger",
            format!("{t}: 11 runs nothing on its own"),
        )),
    }
}

/// Everything 06's definition says, sorted into mapped and refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub author: [u8; 32],
    /// `(param name, bounds, 06's default)` for the `int` params.
    pub args: Vec<(String, ArgSpec, Option<i64>)>,
    /// Every part with no counterpart of the same meaning.
    pub refused: Vec<BridgeError>,
}

/// 06 → 11, as far as the meaning is the same. A definition whose steps
/// are commands (all of 06's today) always has refused parts: 11 cannot
/// run it, only read its identity and bounds.
pub fn creation_to_eleven(manifest: &Value) -> Result<Report, BridgeError> {
    let author = author_key(manifest)?;
    let mut args = Vec::new();
    let mut refused = Vec::new();
    if let Some(ps) = manifest.get("params").and_then(Value::as_object) {
        for (k, p) in ps {
            match int_param(k, p) {
                Ok((a, d)) => args.push((k.clone(), a, d)),
                Err(e @ BridgeError::NotMappable { .. }) => refused.push(e),
                Err(e) => return Err(e),
            }
        }
    }
    for (i, s) in manifest
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let eff = s.get("effect").and_then(Value::as_str).unwrap_or("?");
        refused.push(refuse(
            format!("steps[{i}].effect"),
            format!("{eff} is an existing command; 11's effect set 1 has no command op"),
        ));
    }
    if manifest
        .get("limits")
        .and_then(|l| l.get("runsPerDay"))
        .is_some()
    {
        refused.push(refuse(
            "limits.runsPerDay",
            "accepted starts per day; 11's calls_left is a total",
        ));
    }
    if manifest.get("validUntilDay").is_some_and(|v| !v.is_null()) {
        refused.push(refuse(
            "validUntilDay",
            "the author's deadline; 11's grant expiry is the user's",
        ));
    }
    if let Err(e) = check_trigger(manifest) {
        refused.push(e);
    }
    Ok(Report {
        author,
        args,
        refused,
    })
}

/// 11 → 06: nothing of an 11 manifest's ops is an existing command, so
/// every entry is a new world effect (06's D, `EFFECT_UNKNOWN`). Refused
/// whole; whether 06 ever holds such a definition is 06's (and the
/// owner's) decision.
pub fn eleven_to_creation(m: &Manifest) -> Result<Value, BridgeError> {
    let ops: usize = m.entries.iter().map(|e| e.ops.len()).sum();
    Err(refuse(
        "entries",
        format!(
            "{ops} op(s) of effect set {}: new world effects (06 case D)",
            m.effect_set
        ),
    ))
}
