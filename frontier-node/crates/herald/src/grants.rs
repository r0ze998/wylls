//! ② rights (feature `rights-records`, off by default): the Grants of the
//! season, folded from their PS2 records (kinds 114–119,
//! `frontier_abi::v2::rights::record`) and served as `GET /h/grants`.
//!
//! **Source.** The records are the source of every field: GRANT_ISSUED
//! creates the entry (its terms, the facility Holding and the station
//! Vault in one Province), SWAP_RESERVED opens a reservation, SWAP_EXECUTED
//! closes it as an executed swap, SWAP_RELEASED undoes it, GRANT_REVOKED
//! ends the Grant (an open reservation undone with it), GRANT_CLOSED
//! returns its rent. When the transaction's post-states carry the Grant
//! account (the local node's feed does; a public RPC's does not), its raw
//! bytes are kept beside the entry (`account`, base64, with
//! `accountSlot`): the herald is never a trust root, so the page may read
//! the Grant's own `SWAPS` (the next `seq`) from the account bytes, or ask
//! the chain for them.
//!
//! **Answer** (`frontier-herald-grants-v1`; u64/i64 as decimal strings,
//! addresses base58):
//!
//! ```json
//! {"schema": "frontier-herald-grants-v1", "season": 11, "through_slot": "812",
//!  "grants": [{"address": "…", "issuer_tag": "…", "nonce": 0,
//!    "issuer_citizen": "…" | null, "grantee_citizen": "…" | null, "grantee_tag": "…",
//!    "facility": "…", "facility_site": 3, "station": "…", "station_tile": 22, "p": 0, "q": 1,
//!    "kind": 1, "state": "active" | "revoked" | "closed",
//!    "max_swaps": 4, "swaps": 1, "max_units": 10, "units_swapped": 1, "open_units": 0,
//!    "expires_ts": "…", "issued_ts": "…", "revoked_ts": "…" | null,
//!    "account": "<base64>" | null, "accountSlot": "…" | null,
//!    "events": [{"kind": "issued" | "reserved" | "executed" | "released" | "revoked" | "closed",
//!      "slot": "…", "signature": "…", "units": 1, "by": "grantee" | "after_expiry" | "stale_holding" | "issuer",
//!      "returned": ["ore", "wood", "arms" milli], "kept": […]}]}]}
//! ```
//!
//! `units` only on reserved/executed; `by`, `returned` and `kept` only on
//! released/revoked. A citizen is `null` while the herald has not captured
//! a Citizen of that tag. `events` keeps the last [`EVENTS_PER_GRANT`].
//!
//! **Who sees what (the page's fog rule).** The chain is public, and so is
//! this unfiltered answer (like `/h/caravans.json`). `?citizen=<base58>`
//! answers only the Grants that Citizen is a party to (issuer or grantee):
//! the page asks with its own Citizen and never draws a Grant it is not a
//! party to.

use std::collections::BTreeMap;

use frontier_abi::bytes::rd_u16;
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::log::Record;
use frontier_abi::v2::rights::{self as rt, record as rec};
use serde_json::{json, Value};

use crate::fold::Fold;
use crate::records::B64;
use base64::Engine as _;

pub const SCHEMA: &str = "frontier-herald-grants-v1";
/// Most events kept per Grant (the oldest dropped first).
pub const EVENTS_PER_GRANT: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantEvent {
    pub kind: &'static str,
    pub slot: u64,
    pub signature: String,
    pub units: Option<u32>,
    pub by: Option<u8>,
    pub returned: Option<[i64; 3]>,
    pub kept: Option<[i64; 3]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantEntry {
    pub issuer_tag: u64,
    pub nonce: u32,
    pub grantee_tag: u64,
    pub p: i32,
    pub q: i32,
    pub facility_site: u8,
    pub facility_gen: u8,
    pub station_tile: u8,
    pub station_gen: u8,
    pub max_swaps: u16,
    pub max_units: u32,
    pub expires_ts: i64,
    pub issued_ts: i64,
    pub swaps: u16,
    pub units_swapped: u32,
    pub open_units: u32,
    /// "active", "revoked" or "closed".
    pub state: &'static str,
    pub revoked_ts: Option<i64>,
    /// The Grant account's bytes as last written by a folded transaction.
    pub account: Option<(u64, Vec<u8>)>,
    pub events: Vec<GrantEvent>,
}

/// The season's Grants by `(issuer_tag, nonce)`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Grants {
    pub by_key: BTreeMap<(u64, u32), GrantEntry>,
    /// Records of a Grant the herald never saw issued (or that did not decode).
    pub orphans: u64,
}

fn by_name(b: u8) -> &'static str {
    match b {
        rec::by::GRANTEE => "grantee",
        rec::by::AFTER_EXPIRY => "after_expiry",
        rec::by::STALE_HOLDING => "stale_holding",
        rec::by::ISSUER => "issuer",
        _ => "unknown",
    }
}
fn by_code(s: &str) -> Option<u8> {
    Some(match s {
        "grantee" => rec::by::GRANTEE,
        "after_expiry" => rec::by::AFTER_EXPIRY,
        "stale_holding" => rec::by::STALE_HOLDING,
        "issuer" => rec::by::ISSUER,
        _ => return None,
    })
}
fn kind_name(k: CqKind) -> Option<&'static str> {
    Some(match k {
        CqKind::GRANT_ISSUED => "issued",
        CqKind::SWAP_RESERVED => "reserved",
        CqKind::SWAP_EXECUTED => "executed",
        CqKind::SWAP_RELEASED => "released",
        CqKind::GRANT_REVOKED => "revoked",
        CqKind::GRANT_CLOSED => "closed",
        _ => return None,
    })
}
fn static_kind(s: &str) -> Option<&'static str> {
    [
        "issued", "reserved", "executed", "released", "revoked", "closed",
    ]
    .into_iter()
    .find(|k| *k == s)
}
fn static_state(s: &str) -> Option<&'static str> {
    ["active", "revoked", "closed"]
        .into_iter()
        .find(|k| *k == s)
}

/// The Province a Grant record is about (`None` for GRANT_CLOSED, whose
/// payload has none, or a body that does not decode).
pub fn province_of(kind: CqKind, payload: &[u8]) -> Option<(i32, i32)> {
    match kind {
        CqKind::GRANT_ISSUED => rec::Issued::from_bytes(payload).map(|x| (x.p, x.q)),
        CqKind::SWAP_RESERVED | CqKind::SWAP_EXECUTED => {
            rec::Swap::from_bytes(payload).map(|x| (x.p, x.q))
        }
        CqKind::SWAP_RELEASED | CqKind::GRANT_REVOKED => {
            rec::Undo::from_bytes(payload).map(|x| (x.p, x.q))
        }
        _ => None,
    }
}

impl Grants {
    /// Folds one Grant record of the transaction at `slot` (`block_time`,
    /// `signature`); `post` is the transaction's post-states, searched for
    /// the Grant account at `grant_at`. `false` when `r` is no Grant record
    /// or it does not decode (counted in `orphans`).
    #[allow(clippy::too_many_arguments)]
    pub fn fold(
        &mut self,
        r: &Record<'_>,
        kind: CqKind,
        slot: u64,
        block_time: i64,
        signature: &str,
        grant_account: impl Fn(u64, u32) -> Option<Option<Vec<u8>>>,
    ) -> bool {
        let Some(name) = kind_name(kind) else {
            return false;
        };
        let Some((issuer_tag, nonce)) = rec::of_key(r.key).filter(|_| r.key.len() == 12) else {
            self.orphans += 1;
            return false;
        };
        let k = (issuer_tag, nonce);
        let mut ev = GrantEvent {
            kind: name,
            slot,
            signature: signature.to_string(),
            units: None,
            by: None,
            returned: None,
            kept: None,
        };
        if kind == CqKind::GRANT_ISSUED {
            let Some(x) = rec::Issued::from_bytes(r.payload) else {
                self.orphans += 1;
                return false;
            };
            // (a nonce is issued once: a second ISSUED of the same key replaces nothing silently — it starts anew)
            self.by_key.insert(
                k,
                GrantEntry {
                    issuer_tag,
                    nonce,
                    grantee_tag: x.grantee_tag,
                    p: x.p,
                    q: x.q,
                    facility_site: x.facility_site,
                    facility_gen: x.facility_gen,
                    station_tile: x.station_site,
                    station_gen: x.station_gen,
                    max_swaps: x.max_swaps,
                    max_units: x.max_units,
                    expires_ts: x.expires_ts,
                    issued_ts: block_time,
                    swaps: 0,
                    units_swapped: 0,
                    open_units: 0,
                    state: "active",
                    revoked_ts: None,
                    account: None,
                    events: Vec::new(),
                },
            );
        }
        let Some(g) = self.by_key.get_mut(&k) else {
            self.orphans += 1;
            return false;
        };
        match kind {
            CqKind::SWAP_RESERVED | CqKind::SWAP_EXECUTED => {
                let Some(x) = rec::Swap::from_bytes(r.payload) else {
                    self.orphans += 1;
                    return false;
                };
                ev.units = Some(x.units);
                if kind == CqKind::SWAP_RESERVED {
                    g.open_units = x.units;
                } else {
                    g.open_units = 0;
                    g.swaps = g.swaps.saturating_add(1);
                    g.units_swapped = g.units_swapped.saturating_add(x.units);
                }
            }
            CqKind::SWAP_RELEASED | CqKind::GRANT_REVOKED => {
                let Some(x) = rec::Undo::from_bytes(r.payload) else {
                    self.orphans += 1;
                    return false;
                };
                ev.by = Some(x.by);
                ev.returned = Some(x.returned);
                ev.kept = Some(x.kept);
                g.open_units = 0;
                if kind == CqKind::GRANT_REVOKED {
                    g.state = "revoked";
                    g.revoked_ts = Some(block_time);
                }
            }
            CqKind::GRANT_CLOSED => {
                g.state = "closed";
                g.open_units = 0;
            }
            _ => {}
        }
        match grant_account(issuer_tag, nonce) {
            Some(Some(bytes)) if bytes.get(..8) == Some(&rt::layout::MAGIC[..]) => {
                g.account = Some((slot, bytes))
            }
            Some(_) => g.account = None,
            None => {}
        }
        g.events.push(ev);
        if g.events.len() > EVENTS_PER_GRANT {
            let n = g.events.len() - EVENTS_PER_GRANT;
            g.events.drain(..n);
        }
        true
    }

    /// The checkpoint form (the inverse is [`Grants::from_json`]).
    pub fn to_json(&self) -> Value {
        let arr3 = |a: &[i64; 3]| json!([a[0].to_string(), a[1].to_string(), a[2].to_string()]);
        json!({
            "orphans": self.orphans,
            "grants": self.by_key.values().map(|g| json!({
                "issuerTag": g.issuer_tag.to_string(), "nonce": g.nonce, "granteeTag": g.grantee_tag.to_string(),
                "p": g.p, "q": g.q, "facilitySite": g.facility_site, "facilityGen": g.facility_gen,
                "stationTile": g.station_tile, "stationGen": g.station_gen, "maxSwaps": g.max_swaps,
                "maxUnits": g.max_units, "expiresTs": g.expires_ts.to_string(), "issuedTs": g.issued_ts.to_string(),
                "swaps": g.swaps, "unitsSwapped": g.units_swapped, "openUnits": g.open_units, "state": g.state,
                "revokedTs": g.revoked_ts.map(|t| t.to_string()),
                "account": g.account.as_ref().map(|(s, b)| json!([s.to_string(), B64.encode(b)])),
                "events": g.events.iter().map(|e| json!({"kind": e.kind, "slot": e.slot.to_string(),
                    "signature": e.signature, "units": e.units, "by": e.by.map(by_name),
                    "returned": e.returned.as_ref().map(arr3), "kept": e.kept.as_ref().map(arr3)})).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }

    /// `None` when damaged.
    pub fn from_json(v: &Value) -> Option<Grants> {
        let s64 = |x: &Value| x.as_str()?.parse::<i64>().ok();
        let su64 = |x: &Value| x.as_str()?.parse::<u64>().ok();
        let arr3 = |x: &Value| -> Option<Option<[i64; 3]>> {
            if x.is_null() {
                return Some(None);
            }
            let a = x.as_array()?;
            if a.len() != 3 {
                return None;
            }
            Some(Some([s64(&a[0])?, s64(&a[1])?, s64(&a[2])?]))
        };
        let mut out = Grants {
            orphans: v["orphans"].as_u64()?,
            ..Default::default()
        };
        for g in v["grants"].as_array()? {
            let n8 = |k: &str| g[k].as_u64().and_then(|x| u8::try_from(x).ok());
            let mut events = Vec::new();
            for e in g["events"].as_array()? {
                events.push(GrantEvent {
                    kind: static_kind(e["kind"].as_str()?)?,
                    slot: su64(&e["slot"])?,
                    signature: e["signature"].as_str()?.to_string(),
                    units: match &e["units"] {
                        Value::Null => None,
                        x => Some(u32::try_from(x.as_u64()?).ok()?),
                    },
                    by: match &e["by"] {
                        Value::Null => None,
                        x => Some(by_code(x.as_str()?)?),
                    },
                    returned: arr3(&e["returned"])?,
                    kept: arr3(&e["kept"])?,
                });
            }
            let account = match &g["account"] {
                Value::Null => None,
                x => {
                    let a = x.as_array()?;
                    Some((su64(a.first()?)?, B64.decode(a.get(1)?.as_str()?).ok()?))
                }
            };
            let e = GrantEntry {
                issuer_tag: su64(&g["issuerTag"])?,
                nonce: u32::try_from(g["nonce"].as_u64()?).ok()?,
                grantee_tag: su64(&g["granteeTag"])?,
                p: i32::try_from(g["p"].as_i64()?).ok()?,
                q: i32::try_from(g["q"].as_i64()?).ok()?,
                facility_site: n8("facilitySite")?,
                facility_gen: n8("facilityGen")?,
                station_tile: n8("stationTile")?,
                station_gen: n8("stationGen")?,
                max_swaps: u16::try_from(g["maxSwaps"].as_u64()?).ok()?,
                max_units: u32::try_from(g["maxUnits"].as_u64()?).ok()?,
                expires_ts: s64(&g["expiresTs"])?,
                issued_ts: s64(&g["issuedTs"])?,
                swaps: u16::try_from(g["swaps"].as_u64()?).ok()?,
                units_swapped: u32::try_from(g["unitsSwapped"].as_u64()?).ok()?,
                open_units: u32::try_from(g["openUnits"].as_u64()?).ok()?,
                state: static_state(g["state"].as_str()?)?,
                revoked_ts: match &g["revokedTs"] {
                    Value::Null => None,
                    x => Some(s64(x)?),
                },
                account,
                events,
            };
            out.by_key.insert((e.issuer_tag, e.nonce), e);
        }
        Some(out)
    }
}

fn b58(a: &[u8; 32]) -> String {
    solana_address::Address::new_from_array(*a).to_string()
}

/// Citizen tag → the captured Citizen's address. The program's tags are
/// `citizen_tag(address)` (its first 8 bytes; the Grant's issuer and
/// grantee tags, as the Citizen's stored `CITIZEN_TAG`).
fn citizens_by_tag(f: &Fold) -> BTreeMap<u64, [u8; 32]> {
    let mut m = BTreeMap::new();
    for (addr, c) in &f.st.accounts {
        if crate::conquest::kind_v1(&c.data) == Some(frontier_abi::layout::AccountKind::Citizen) {
            m.insert(frontier_abi::addr::citizen_tag(addr), *addr);
        }
    }
    m
}

/// `/h/grants` (`filter`: a Citizen's tag; only the Grants it is a party to).
pub fn grants_json(f: &Fold, filter: Option<u64>) -> Value {
    let tags = citizens_by_tag(f);
    let arr3 = |a: &[i64; 3]| json!([a[0].to_string(), a[1].to_string(), a[2].to_string()]);
    let grants: Vec<Value> = f
        .cq
        .grants
        .by_key
        .values()
        .filter(|g| filter.is_none_or(|t| g.issuer_tag == t || g.grantee_tag == t))
        .map(|g| {
            let swaps_on_chain = g
                .account
                .as_ref()
                .and_then(|(_, b)| rd_u16(b, rt::layout::SWAPS));
            json!({
                "address": b58(&rt::grant(&f.ctx, g.issuer_tag, g.nonce)),
                "issuer_tag": g.issuer_tag.to_string(),
                "nonce": g.nonce,
                "issuer_citizen": tags.get(&g.issuer_tag).map(b58),
                "grantee_tag": g.grantee_tag.to_string(),
                "grantee_citizen": tags.get(&g.grantee_tag).map(b58),
                "facility": b58(&f.ctx.holding(g.p, g.q, g.facility_site)),
                "facility_site": g.facility_site,
                "station": b58(&frontier_abi::v2::addr::vault(&f.ctx, g.p, g.q, g.station_tile)),
                "station_tile": g.station_tile,
                "p": g.p, "q": g.q,
                "kind": rt::KIND_STOCK_SWAP,
                "state": g.state,
                "max_swaps": g.max_swaps, "swaps": swaps_on_chain.unwrap_or(g.swaps),
                "max_units": g.max_units, "units_swapped": g.units_swapped, "open_units": g.open_units,
                "expires_ts": g.expires_ts.to_string(), "issued_ts": g.issued_ts.to_string(),
                "revoked_ts": g.revoked_ts.map(|t| t.to_string()),
                "account": g.account.as_ref().map(|(_, b)| B64.encode(b)),
                "accountSlot": g.account.as_ref().map(|(s, _)| s.to_string()),
                "events": g.events.iter().map(|e| {
                    let mut v = json!({"kind": e.kind, "slot": e.slot.to_string(), "signature": e.signature});
                    if let Some(u) = e.units { v["units"] = json!(u); }
                    if let Some(b) = e.by { v["by"] = json!(by_name(b)); }
                    if let Some(a) = &e.returned { v["returned"] = arr3(a); }
                    if let Some(a) = &e.kept { v["kept"] = arr3(a); }
                    v
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "schema": SCHEMA,
        "season": f.cfg.season_id,
        "through_slot": f.st.last_slot.to_string(),
        "grants": grants,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fold::{Capture, FoldCfg};
    use fclient::ports::{Account, Signature, TxRecord};
    use frontier_abi::layout::player::citizen as C;
    use frontier_abi::v2::log::{self as v2log, AnyKind};
    use solana_address::Address;

    const PROGRAM: [u8; 32] = [0x45; 32];
    const SID: u64 = 11;
    const ISSUER_W: [u8; 32] = [3; 32];
    const GRANTEE_W: [u8; 32] = [4; 32];

    fn fold() -> Fold {
        let dir = std::env::temp_dir().join(format!(
            "herald-grants-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let mut f = Fold::new(
            FoldCfg {
                program: Address::new_from_array(PROGRAM),
                season_id: SID,
                builder: std::sync::Arc::new(crate::clash::Provisional),
                exact_post: true,
            },
            crate::files::Out::new(dir),
        );
        for w in [ISSUER_W, GRANTEE_W] {
            let at = f.ctx.citizen(&w);
            let mut data = vec![0; C::SIZE];
            data[..8].copy_from_slice(&C::MAGIC);
            data[8..16].copy_from_slice(&SID.to_le_bytes());
            data[C::WALLET..C::WALLET + 32].copy_from_slice(&w);
            data[C::CITIZEN_TAG..C::CITIZEN_TAG + 8]
                .copy_from_slice(&frontier_abi::addr::citizen_tag(&at).to_le_bytes());
            f.st.accounts.insert(
                at,
                Capture {
                    slot: 1,
                    tx: 1,
                    data,
                },
            );
        }
        f
    }

    fn tags(f: &Fold) -> (u64, u64) {
        (
            frontier_abi::addr::citizen_tag(&f.ctx.citizen(&ISSUER_W)),
            frontier_abi::addr::citizen_tag(&f.ctx.citizen(&GRANTEE_W)),
        )
    }

    fn body(kind: CqKind, key: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 512];
        let n = v2log::write_body(AnyKind::Cq(kind), 7, key, payload, &mut out).unwrap();
        let m = v2log::write_tail(&[], &mut out, n).unwrap();
        out.truncate(m);
        out
    }

    fn tx(seq: u64, bodies: Vec<Vec<u8>>, post: Vec<([u8; 32], Option<Vec<u8>>)>) -> TxRecord {
        let mut sig = [0u8; 64];
        sig[..8].copy_from_slice(&seq.to_le_bytes());
        TxRecord {
            seq,
            slot: 100 + seq,
            signature: Signature::from(sig),
            block_time: 1_800_000_000 + seq as i64,
            tx: vec![],
            logs: fclient::log::in_frame(
                &Address::new_from_array(PROGRAM),
                bodies.iter().map(|b| fclient::log::log_line(b)),
            ),
            err: None,
            code: None,
            units: 0,
            fee: 5_000,
            post: post
                .into_iter()
                .map(|(k, d)| {
                    (
                        Address::new_from_array(k),
                        d.map(|data| Account {
                            lamports: 1,
                            data,
                            owner: Address::new_from_array(PROGRAM),
                            executable: false,
                        }),
                    )
                })
                .collect(),
            loaded: Default::default(),
        }
    }

    fn grant_bytes(swaps: u16) -> Vec<u8> {
        let mut d = vec![0u8; rt::layout::SIZE];
        d[..8].copy_from_slice(&rt::layout::MAGIC);
        d[rt::layout::SWAPS..rt::layout::SWAPS + 2].copy_from_slice(&swaps.to_le_bytes());
        d
    }

    fn swap(grantee: u64, seq: u16, units: u32) -> Vec<u8> {
        rec::Swap {
            grantee_tag: grantee,
            p: 0,
            q: 1,
            facility_site: 3,
            station_site: 22,
            seq,
            units,
            ore: 0,
            wood: 0,
            arms: 1000,
        }
        .to_bytes()
        .to_vec()
    }

    fn undo(by: u8) -> Vec<u8> {
        rec::Undo {
            by,
            p: 0,
            q: 1,
            facility_site: 3,
            station_site: 22,
            returned: [2000, 1000, 1000],
            kept: [0, 0, 0],
        }
        .to_bytes()
        .to_vec()
    }

    /// The six records of one Grant's life, folded through the real record loop.
    fn lived(f: &mut Fold) -> [u8; 32] {
        let (it, gt) = tags(f);
        let key = rec::key(it, 5);
        let at = rt::grant(&f.ctx, it, 5);
        let issued = rec::Issued {
            grantee_tag: gt,
            p: 0,
            q: 1,
            facility_site: 3,
            facility_gen: 1,
            station_site: 22,
            station_gen: 1,
            max_swaps: 4,
            max_units: 10,
            expires_ts: 1_900_000_000,
            rent: 3_000_000,
        };
        let steps: Vec<(CqKind, Vec<u8>, Option<Vec<u8>>)> = vec![
            (
                CqKind::GRANT_ISSUED,
                issued.to_bytes().to_vec(),
                Some(grant_bytes(0)),
            ),
            (CqKind::SWAP_RESERVED, swap(gt, 0, 2), Some(grant_bytes(0))),
            (CqKind::SWAP_EXECUTED, swap(gt, 0, 2), Some(grant_bytes(1))),
            (CqKind::SWAP_RESERVED, swap(gt, 1, 1), Some(grant_bytes(1))),
            (
                CqKind::SWAP_RELEASED,
                undo(rec::by::GRANTEE),
                Some(grant_bytes(1)),
            ),
            (CqKind::SWAP_RESERVED, swap(gt, 1, 1), Some(grant_bytes(1))),
            (
                CqKind::GRANT_REVOKED,
                undo(rec::by::ISSUER),
                Some(grant_bytes(1)),
            ),
        ];
        for (i, (k, p, post)) in steps.into_iter().enumerate() {
            f.apply(&tx(i as u64 + 1, vec![body(k, &key, &p)], vec![(at, post)]));
        }
        at
    }

    #[test]
    fn each_record_folds_into_the_grant() {
        let mut f = fold();
        let at = lived(&mut f);
        let g = f.cq.grants.by_key.values().next().expect("the Grant");
        assert_eq!(
            (g.swaps, g.units_swapped, g.open_units, g.state),
            (1, 2, 0, "revoked")
        );
        assert_eq!(g.revoked_ts, Some(1_800_000_007));
        assert_eq!(g.issued_ts, 1_800_000_001);
        let kinds: Vec<_> = g.events.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            ["issued", "reserved", "executed", "reserved", "released", "reserved", "revoked"]
        );
        assert_eq!(g.events[4].by, Some(rec::by::GRANTEE));
        assert_eq!(g.events[6].returned, Some([2000, 1000, 1000]));
        // closed: the account is gone from the post-states
        let (it, _) = tags(&f);
        let closed = rec::Closed {
            rent: 3_000_000,
            rent_to8: 1,
        }
        .to_bytes();
        f.apply(&tx(
            9,
            vec![body(CqKind::GRANT_CLOSED, &rec::key(it, 5), &closed)],
            vec![(at, None)],
        ));
        let g = f.cq.grants.by_key.values().next().unwrap();
        assert_eq!(g.state, "closed");
        assert_eq!(g.account, None);
        assert_eq!(f.cq.grants.orphans, 0);
    }

    #[test]
    fn the_answer_names_the_parties_places_and_events() {
        let mut f = fold();
        let at = lived(&mut f);
        let v = grants_json(&f, None);
        assert_eq!(v["schema"], SCHEMA);
        assert_eq!(v["season"], SID);
        let g = &v["grants"][0];
        assert_eq!(g["address"], b58(&at));
        assert_eq!(g["issuer_citizen"], b58(&f.ctx.citizen(&ISSUER_W)));
        assert_eq!(g["grantee_citizen"], b58(&f.ctx.citizen(&GRANTEE_W)));
        assert_eq!(g["facility"], b58(&f.ctx.holding(0, 1, 3)));
        assert_eq!(
            g["station"],
            b58(&frontier_abi::v2::addr::vault(&f.ctx, 0, 1, 22))
        );
        assert_eq!(g["state"], "revoked");
        assert_eq!(g["swaps"], 1);
        assert_eq!(g["expires_ts"], "1900000000");
        assert_eq!(g["events"][1]["units"], 2);
        assert_eq!(g["events"][6]["by"], "issuer");
        assert!(g["events"][0].get("units").is_none());
        assert_eq!(g["accountSlot"], "107");
        // the fog filter: a party sees it, a stranger does not
        let (it, gt) = tags(&f);
        assert_eq!(
            grants_json(&f, Some(it))["grants"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            grants_json(&f, Some(gt))["grants"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            grants_json(&f, Some(it ^ 1))["grants"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn a_record_of_an_unseen_grant_or_a_bad_body_is_an_orphan() {
        let mut f = fold();
        let (it, gt) = tags(&f);
        f.apply(&tx(
            1,
            vec![body(
                CqKind::SWAP_RESERVED,
                &rec::key(it, 9),
                &swap(gt, 0, 1),
            )],
            vec![],
        ));
        assert!(f.cq.grants.by_key.is_empty());
        assert_eq!(f.cq.grants.orphans, 1);
    }

    #[test]
    fn the_checkpoint_round_trips() {
        let mut f = fold();
        lived(&mut f);
        let j = f.cq.grants.to_json();
        assert_eq!(Grants::from_json(&j).as_ref(), Some(&f.cq.grants));
        let c = crate::conquest::Cq::from_json(&f.cq.to_json()).expect("the Cq checkpoint");
        assert_eq!(c.grants, f.cq.grants);
    }

    #[test]
    fn a_grant_record_is_scoped_to_its_province() {
        assert_eq!(
            province_of(CqKind::SWAP_EXECUTED, &swap(1, 0, 1)),
            Some((0, 1))
        );
        assert_eq!(province_of(CqKind::GRANT_CLOSED, &[0; 16]), None);
    }
}
