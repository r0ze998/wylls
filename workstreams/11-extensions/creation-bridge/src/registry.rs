//! 06's registry export (`Registry.toJSON()`), read and checked: every
//! version's envelope verifies, the entry key is `author/name`, and the
//! status log is consistent (a publication opens it as `listed` with its
//! version; each status change carries `seq` = its position; the entry's
//! status is the log's last). 11 resolves a plan's pinned reference against
//! it and does **not** copy it into a registry of its own.
//!
//! The export keeps no signature for a status change: the log says *that*
//! the status changed, not *who* signed it. [`verify_status_change`]
//! checks a signature when 06 supplies one alongside.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::envelope::{status_message, verify, verify_envelope, Publication, STATUS};
use crate::BridgeError;

/// 06's publication status (per entry, not per version). Not 11's
/// execution status: there is no conversion to `ext-kernel`'s `Status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublicationStatus {
    Listed,
    Suspended,
    Withdrawn,
}

impl PublicationStatus {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "listed" => Self::Listed,
            "suspended" => Self::Suspended,
            "withdrawn" => Self::Withdrawn,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub author: String,
    pub name: String,
    pub status: PublicationStatus,
    /// version → checked publication.
    pub versions: BTreeMap<String, Publication>,
}

/// A plan's pin (06's `plan.manifest`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedRef {
    pub author: String,
    pub name: String,
    pub version: String,
    pub hash: String,
}

/// What 11 learns about a pinned reference, with 06's meaning of status
/// (`docs/05-update-policy.ja.md` §2): a suspended or withdrawn entry stops
/// new adoptions (`ENTRY_NOT_LISTED`) and never an adopted, pinned plan
/// (`ENTRY_DELISTED_PINNED`, a notice).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub publication: Publication,
    pub status: PublicationStatus,
    pub may_adopt_anew: bool,
    pub adopted_plan_runs: bool,
}

/// The checked view of one export.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreationRegistry {
    pub entries: BTreeMap<String, Entry>,
}

fn field<'a>(v: &'a Value, k: &str, what: &str) -> Result<&'a Value, BridgeError> {
    v.get(k)
        .ok_or_else(|| BridgeError::Shape(format!("{what}: no {k}")))
}

impl CreationRegistry {
    pub fn from_json(v: &Value) -> Result<CreationRegistry, BridgeError> {
        let entries = field(v, "entries", "registry")?
            .as_object()
            .ok_or_else(|| BridgeError::Shape("entries is not an object".into()))?;
        let mut out = BTreeMap::new();
        for (key, e) in entries {
            let s = |k: &str| {
                field(e, k, key)?
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| BridgeError::Shape(format!("{key}: {k} is not a string")))
            };
            let (author, name) = (s("author")?, s("name")?);
            if *key != format!("{author}/{name}") {
                return Err(BridgeError::Shape(format!("{key}: key is not author/name")));
            }
            let status = PublicationStatus::parse(&s("status")?)
                .ok_or_else(|| BridgeError::Shape(format!("{key}: unknown status")))?;
            let mut versions = BTreeMap::new();
            for (ver, env) in field(e, "versions", key)?
                .as_object()
                .ok_or_else(|| BridgeError::Shape(format!("{key}: versions")))?
            {
                let p = verify_envelope(env)?;
                if p.author != author || p.name != name || p.version != *ver {
                    return Err(BridgeError::Shape(format!(
                        "{key}@{ver}: the envelope names another definition"
                    )));
                }
                versions.insert(ver.clone(), p);
            }
            check_log(key, field(e, "statusLog", key)?, status, &versions)?;
            out.insert(
                key.clone(),
                Entry {
                    author,
                    name,
                    status,
                    versions,
                },
            );
        }
        Ok(CreationRegistry { entries: out })
    }

    /// The pinned version, exactly as published, with 06's status.
    pub fn resolve(&self, pin: &PinnedRef) -> Result<Resolved, BridgeError> {
        let e = self
            .entries
            .get(&format!("{}/{}", pin.author, pin.name))
            .ok_or(BridgeError::NotFound)?;
        let p = e.versions.get(&pin.version).ok_or(BridgeError::NotFound)?;
        if p.hash != pin.hash {
            return Err(BridgeError::PinMismatch {
                pinned: pin.hash.clone(),
                published: p.hash.clone(),
            });
        }
        Ok(Resolved {
            publication: p.clone(),
            status: e.status,
            may_adopt_anew: e.status == PublicationStatus::Listed,
            adopted_plan_runs: true,
        })
    }
}

/// Every publication opens with `listed` and its version (once per
/// version); a status change has `seq` = its index; the entry's status is
/// the last one.
fn check_log(
    key: &str,
    log: &Value,
    status: PublicationStatus,
    versions: &BTreeMap<String, Publication>,
) -> Result<(), BridgeError> {
    let bad = |d: &str| BridgeError::StatusLog(format!("{key}: {d}"));
    let log = log.as_array().ok_or_else(|| bad("not an array"))?;
    let mut published = Vec::new();
    let mut last = None;
    for (i, item) in log.iter().enumerate() {
        let st = item
            .get("status")
            .and_then(Value::as_str)
            .and_then(PublicationStatus::parse)
            .ok_or_else(|| bad("an item has no known status"))?;
        match (item.get("version"), item.get("seq")) {
            (Some(v), None) => {
                let v = v.as_str().ok_or_else(|| bad("version is not a string"))?;
                if st != PublicationStatus::Listed
                    || !versions.contains_key(v)
                    || published.contains(&v)
                {
                    return Err(bad("a publication item that is not one listed version"));
                }
                published.push(v);
            }
            (None, Some(s)) => {
                if s.as_u64() != Some(i as u64) {
                    return Err(bad("a status change whose seq is not its position"));
                }
            }
            _ => {
                return Err(bad(
                    "an item that is neither a publication nor a status change",
                ))
            }
        }
        last = Some(st);
    }
    if published.len() != versions.len() {
        return Err(bad("a version without its publication item"));
    }
    if last != Some(status) {
        return Err(bad("the entry's status is not the log's last"));
    }
    Ok(())
}

/// A status change's signature, when 06 hands it over (the export has
/// none): the author's, in the status domain, over `{author, name, status,
/// seq}`.
pub fn verify_status_change(
    author: &str,
    name: &str,
    status: &str,
    seq: u64,
    sig_hex: &str,
) -> Result<bool, BridgeError> {
    Ok(verify(
        author,
        STATUS,
        &status_message(author, name, status, seq)?,
        sig_hex,
    ))
}
