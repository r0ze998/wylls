//! The AI's own hosts, transits and seals from `/h/me/{wallet}` (contract
//! §1.3 C2, §3.1 step 1). `agents::obs::MeView` keeps only the wallet,
//! Citizen, Holdings and quota; the herald's JSON also carries `hosts`
//! (the own hosts wherever they stand), `transits` (the holdings' transit
//! records) and `seals` (settled seal outcomes, `TRANSIT_SETTLED`) [source:
//! `herald/src/views.rs` `me_json`]. The brain reads them itself.
//!
//! `opened` (§4.1 `own_marches[].opened`) stays `None` until the arrival
//! bell has ended **and** the destination is public (a REVEAL was observed,
//! the march settled, or a seal record exists); only then does the brain
//! put the destination it kept in its marchbook into a request.

use serde_json::Value;

use super::mindport::{id_of, Opened};
use crate::ports::HeraldPort;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeHost {
    pub id: u64,
    pub province: (i16, i16),
    pub state: u8,
    pub faction: u8,
    pub unit: u8,
    pub tile: u8,
    pub troops: u32,
    pub ready_bell: u32,
    pub from_bell: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeTransit {
    pub holding: (i16, i16, u8),
    pub slot: u8,
    pub state: u8,
    pub host: u64,
    pub depart_bell: u32,
    pub arrive_bell: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeSeal {
    pub host: u64,
    pub outcome: u8,
    pub code: u8,
    pub bell: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MeExtra {
    pub hosts: Vec<MeHost>,
    pub transits: Vec<MeTransit>,
    pub seals: Vec<MeSeal>,
}

fn n(v: &Value, k: &str) -> Option<u64> {
    v.get(k).and_then(id_of)
}

impl MeExtra {
    /// Reads the three arrays; a missing array is empty, a malformed row is
    /// an error (the herald is not a trust root, but a bad row means a
    /// changed shape the brain must not guess at).
    pub fn from_json(v: &Value) -> Result<MeExtra, String> {
        let mut out = MeExtra::default();
        let bad = |what: &str| format!("/h/me {what}");
        for h in v.get("hosts").and_then(Value::as_array).into_iter().flatten() {
            let pq = h.get("province").and_then(Value::as_array);
            let (p, q) = match pq.map(|a| a.as_slice()) {
                Some([p, q]) => (
                    p.as_i64().ok_or_else(|| bad("host province"))? as i16,
                    q.as_i64().ok_or_else(|| bad("host province"))? as i16,
                ),
                _ => return Err(bad("host province")),
            };
            out.hosts.push(MeHost {
                id: n(h, "id").ok_or_else(|| bad("host id"))?,
                province: (p, q),
                state: n(h, "state").ok_or_else(|| bad("host state"))? as u8,
                faction: n(h, "faction").unwrap_or(0) as u8,
                unit: n(h, "unit").ok_or_else(|| bad("host unit"))? as u8,
                tile: n(h, "tile").unwrap_or(0) as u8,
                troops: n(h, "troops").unwrap_or(0) as u32,
                ready_bell: n(h, "readyBell").unwrap_or(0) as u32,
                from_bell: n(h, "fromBell").unwrap_or(0) as u32,
            });
        }
        for t in v
            .get("transits")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let hold = t.get("holding").and_then(Value::as_array);
            let holding = match hold.map(|a| a.as_slice()) {
                Some([p, q, s]) => (
                    p.as_i64().ok_or_else(|| bad("transit holding"))? as i16,
                    q.as_i64().ok_or_else(|| bad("transit holding"))? as i16,
                    s.as_u64().ok_or_else(|| bad("transit holding"))? as u8,
                ),
                _ => return Err(bad("transit holding")),
            };
            out.transits.push(MeTransit {
                holding,
                slot: n(t, "transitSlot").unwrap_or(0) as u8,
                state: n(t, "state").unwrap_or(0) as u8,
                host: n(t, "host").ok_or_else(|| bad("transit host"))?,
                depart_bell: n(t, "departBell").ok_or_else(|| bad("transit departBell"))? as u32,
                arrive_bell: n(t, "arriveBell").ok_or_else(|| bad("transit arriveBell"))? as u32,
            });
        }
        for s in v.get("seals").and_then(Value::as_array).into_iter().flatten() {
            out.seals.push(MeSeal {
                host: n(s, "host").ok_or_else(|| bad("seal host"))?,
                outcome: n(s, "outcome").unwrap_or(0) as u8,
                code: n(s, "code").unwrap_or(0) as u8,
                bell: n(s, "bell").unwrap_or(0) as u32,
            });
        }
        Ok(out)
    }

    pub fn seal_of(&self, host: u64) -> Option<&MeSeal> {
        self.seals.iter().find(|s| s.host == host)
    }

    pub fn transit_of(&self, host: u64) -> Option<&MeTransit> {
        self.transits.iter().find(|t| t.host == host)
    }

    pub fn host(&self, id: u64) -> Option<&MeHost> {
        self.hosts.iter().find(|h| h.id == id)
    }
}

/// `GET /h/me/{wallet}`: the extra arrays and the raw bytes (the brain
/// hashes them into `obs_digest`). A 404 (not joined) is an empty view.
pub async fn fetch<H: HeraldPort>(
    herald: &H,
    wallet: &str,
) -> Result<(MeExtra, Vec<u8>), String> {
    match herald.get(&format!("/h/me/{wallet}")).await {
        Ok(Some(b)) => {
            let v: Value = serde_json::from_slice(&b).map_err(|e| format!("/h/me json: {e}"))?;
            Ok((MeExtra::from_json(&v)?, b))
        }
        Ok(None) => Ok((MeExtra::default(), vec![])),
        Err(e) => Err(format!("/h/me: {e}")),
    }
}

/// What `own_marches[].opened` may say at `bell` (§4.1): `None` until the
/// arrival bell has ended **and** the destination is public. `public` is
/// the brain's own knowledge that a REVEAL of the march was observed or the
/// march settled (`MarchMemo::revealed` / `settled`); a seal record in
/// `/h/me` also makes it public. `dest` is the destination the brain kept
/// in its marchbook (never sent before this call).
pub fn opened_of(
    host_id: u64,
    arrive_bell: u32,
    dest: (i16, i16, u8),
    bell: u32,
    public: bool,
    me: &MeExtra,
) -> Option<Opened> {
    if bell <= arrive_bell {
        return None;
    }
    let seal = me.seal_of(host_id);
    if !public && seal.is_none() {
        return None;
    }
    Some(Opened {
        p: dest.0,
        q: dest.1,
        tile: dest.2,
        seal: seal.map(|s| (s.outcome, s.code)),
    })
}
