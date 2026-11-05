//! The caravan send through the agent wallet's gateway (workstream 05's
//! `POST /f/agent/action`, with workstream 03's patch 0005 SendCaravan and
//! workstream 05's patch 0001 limits applied on this branch).
//!
//! **What is real and what is MOCK here.** The gateway code is the shared
//! code as patched; it is reached over loopback HTTP (the test bridge,
//! `bridge/agent-gateway-bridge.mjs`). The chain behind the gateway is the
//! agent wallet tests' scripted chain, and the canonical reads of the run
//! (places, caravans, the facility) are this crate's simulated world (`sim`):
//! when the gateway reports a signature, the port reads the transaction the
//! gateway actually signed, decodes its SendCaravan data with `frontier-abi`
//! and lands exactly that in the simulated world. Nothing reaches a real
//! chain, a wallet, a key store or a paid API.
//!
//! **How the run's guarantees map onto the gateway.**
//! - The gateway signs at send time, so the run cannot journal signed bytes
//!   first (③-R3). It journals an attempt *handle* instead,
//!   `gw:<prepared slot>:<idempotency key>`; the key is fixed per attempt,
//!   so a re-send of the same attempt is the gateway's replay (`replayed:
//!   true`), never a second transaction.
//! - The chain signature becomes known only from the gateway's answer, or,
//!   when the answer was lost, from the agent's public history
//!   (`GET /f/agent?id=`, read-only). [`Chain::chain_sig`] names it; until
//!   then the executor attributes nothing to the attempt.
//! - Since workstream 04's gateway change (2026-11-06) every answer says
//!   whether signed bytes left (`sent`), and a signed one carries its
//!   `signature`, `lastValidBlockHeight`, `slotFloor` and `signedAt`, also
//!   when the send failed after signing (`status: failed, sent: true`). The
//!   port follows such an attempt by the gateway's read-only
//!   `GET /f/agent/fate?id=&key=` (the bridge's `GET /fate?key=`), which
//!   decides only at finalized and proves expiry the way the agent wallet's
//!   reconcile does. Its states map onto the run's:
//!
//!   | gateway `state` | run | meaning |
//!   |---|---|---|
//!   | `landed` | `Landed` | finalized without error |
//!   | `failed` | `Failed` | finalized with an error (fee paid, no effect) |
//!   | `expired` | `Absent` | proved never to land (lifetime past, history covers it) |
//!   | `not-sent` | `Absent` | no bytes left the gateway |
//!   | `pending` | `Pending` | not final; `commitment` says how far it got |
//!   | `unknown` | `Unavailable` | result unknown: past its lifetime, cannot be proved absent |
//!   | `unqueryable` | `Err(PortError::Unavailable)` | the node or the record could not be read |
//!
//!   [`GatewayPort::facts`] gives the same answer with its signature,
//!   lifetime, signing time and commitment, for receipts.
//! - An older gateway (no `sent` field) is read as before: a failure after
//!   signing has no signature and holds the run as indeterminate.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use frontier_abi::v2::layout::s1::place::KIND_VAULT;
use serde_json::{json, Value};

use crate::model::{CaravanKey, PlaceRef, Res, ZERO};
use crate::ports::*;
use crate::sim::Sim;

/// A minimal HTTP/1.1 client for the loopback bridge (no TLS, no proxy).
fn http(port: u16, method: &str, path: &str, body: Option<&Value>) -> Result<(u16, Value), String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let b = body.map(|v| v.to_string()).unwrap_or_default();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}",
        b.len()
    )
    .map_err(|e| e.to_string())?;
    let mut raw = vec![];
    s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, rest) = text.split_once("\r\n\r\n").ok_or("malformed response")?;
    let code = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .ok_or("no status code")?;
    let v = serde_json::from_str(rest).unwrap_or(Value::Null);
    Ok((code, v))
}

/// The facts of a signed attempt, fixed when its bytes left the gateway.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Signed {
    pub signature: String,
    /// The last block height its blockhash is valid at (`None`: not reported).
    pub last_valid_block_height: Option<u64>,
    /// The finalized slot read before it was built (history coverage).
    pub slot_floor: Option<u64>,
    /// The gateway's clock when it signed (unix ms).
    pub signed_at: Option<u64>,
}

/// `GET path` on the loopback gateway or bridge (for [`crate::acts`]).
pub fn http_get(port: u16, path: &str) -> Result<(u16, Value), String> {
    http(port, "GET", path, None)
}

/// What the gateway said about one idempotency key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayResult {
    Sent(Signed),
    /// Refused before anything was signed.
    Refused {
        code: String,
    },
    /// Failed. `signed`: the bytes left signed and may still land (a newer
    /// gateway reports them); `None`: nothing left, or an older gateway that
    /// did not say (`sent_known: false`).
    Failed {
        code: String,
        signed: Option<Signed>,
        sent_known: bool,
    },
}

impl GatewayResult {
    fn signed(&self) -> Option<&Signed> {
        match self {
            GatewayResult::Sent(s) => Some(s),
            GatewayResult::Failed { signed, .. } => signed.as_ref(),
            GatewayResult::Refused { .. } => None,
        }
    }
}

/// One attempt as the gateway's fate read sees it (receipts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptFacts {
    /// `not-sent`, `landed`, `failed`, `expired`, `pending`, `unknown` or
    /// `unqueryable`.
    pub state: String,
    pub signed: Option<Signed>,
    /// `processed`, `confirmed`, `finalized`, or `None` (no status seen).
    pub commitment: Option<String>,
    pub why: String,
}

fn u64_of(v: &Value) -> Option<u64> {
    v.as_u64()
}

/// The signing facts in an answer or history entry (`None` without a signature).
fn signed_of(v: &Value) -> Option<Signed> {
    Some(Signed {
        signature: v["signature"].as_str()?.to_string(),
        last_valid_block_height: u64_of(&v["lastValidBlockHeight"]),
        slot_floor: u64_of(&v["slotFloor"]),
        signed_at: u64_of(&v["signedAt"]),
    })
}

/// A `failed` answer or entry.
fn failed_of(v: &Value, code: String) -> GatewayResult {
    GatewayResult::Failed {
        code,
        signed: if v["sent"] == json!(true) {
            signed_of(v)
        } else {
            None
        },
        sent_known: v["sent"].is_boolean(),
    }
}

/// The agent the run's owner handed its village to.
#[derive(Clone, Debug)]
pub struct Agent {
    pub agent_id: String,
    pub policy_version: u64,
    /// The village `[p, q, site]` the gateway lets the agent act on.
    pub village: (i16, i16, u8),
}

/// The run executor's `Chain` with SendCaravan going through the gateway.
pub struct GatewayPort {
    pub sim: Sim,
    pub port: u16,
    pub agent: Agent,
    /// The run owner's tag in the simulated world.
    pub owner: u64,
    /// Slots after preparing during which an attempt never seen by the
    /// gateway still reads `Pending` (the executor re-sends the same key);
    /// after it, `Unavailable`.
    pub lookup_grace: u64,
    /// Faults the bridge applies to the next POSTs (`drop`, `sendThrows`).
    pub faults: Mutex<VecDeque<&'static str>>,
    results: Mutex<HashMap<String, GatewayResult>>,
}

fn place_json(p: &PlaceRef) -> Value {
    if p.kind == KIND_VAULT {
        json!({ "kind": "vault", "p": p.p, "q": p.q, "tile": p.at })
    } else {
        json!({ "kind": "holding", "p": p.p, "q": p.q, "site": p.at })
    }
}

fn cargo_bytes(c: &Res) -> Vec<u8> {
    c.iter().flat_map(|u| (*u as u32).to_le_bytes()).collect()
}

/// `gw:<slot>:<key>` → `(slot, key)`.
fn parse_handle(h: &str) -> Option<(u64, &str)> {
    let rest = h.strip_prefix("gw:")?;
    let (slot, key) = rest.split_once(':')?;
    Some((slot.parse().ok()?, key))
}

impl GatewayPort {
    pub fn new(sim: Sim, port: u16, agent: Agent, owner: u64) -> GatewayPort {
        GatewayPort {
            sim,
            port,
            agent,
            owner,
            lookup_grace: 10,
            faults: Mutex::new(VecDeque::new()),
            results: Mutex::new(HashMap::new()),
        }
    }

    fn village(&self) -> PlaceRef {
        let (p, q, site) = self.agent.village;
        PlaceRef {
            kind: frontier_abi::v2::layout::s1::place::KIND_HOLDING,
            p,
            q,
            at: site,
            gen: 1,
        }
    }

    /// The gateway's request body for a SendCaravan (an `ActionRequest`).
    fn action(&self, key: &str, seq: u32, src: &PlaceRef, dst: &PlaceRef, cargo: &Res) -> Value {
        let mut provinces = vec![json!({ "p": src.p, "q": src.q })];
        if (dst.p, dst.q) != (src.p, src.q) {
            provinces.push(json!({ "p": dst.p, "q": dst.q }));
        }
        let mut route = json!({ "dst": place_json(dst), "provinces": provinces });
        if *src != self.village() {
            route["src"] = place_json(src);
        }
        json!({
            "source": "mcp",
            "idempotencyKey": key,
            "policyVersion": self.agent.policy_version,
            "reason": "workstream 04 run",
            "action": {
                "name": "SendCaravan",
                "holding": [self.agent.village.0, self.agent.village.1, self.agent.village.2],
                "fields": {
                    "seq": seq, "dst_kind": dst.kind, "dst_p": dst.p, "dst_q": dst.q, "dst_at": dst.at, "dst_gen": dst.gen,
                    "steps": 3, "path": vec![0u8; 12], "cargo": cargo_bytes(cargo), "fee": "50000"
                },
                "route": route
            }
        })
    }

    /// The transaction the gateway signed under `sig`, decoded, landed in
    /// the simulated world (idempotent). `Err`: the bytes are not a
    /// SendCaravan of the agent's village.
    fn land(&self, sig: &str) -> Result<(), String> {
        let (_, t) = http(self.port, "GET", &format!("/tx?sig={sig}"), None)?;
        if t["found"] != json!(true) {
            return Err(format!("{sig}: not on the scripted chain"));
        }
        let data =
            hex::decode(t["data"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
        let x = frontier_abi::v2::ix::SendCaravan::decode(&data).map_err(|e| format!("{e:?}"))?;
        if t["srcIsVillage"] != json!(true) {
            return Err(format!("{sig}: the source is not the agent's village"));
        }
        let mut cargo = ZERO;
        for (i, c) in cargo.iter_mut().enumerate() {
            *c = u32::from_le_bytes(x.cargo[4 * i..4 * i + 4].try_into().unwrap()) as u64;
        }
        let req = Request::SendCaravan {
            owner: self.owner,
            seq: x.seq,
            src: self.village(),
            dst: PlaceRef {
                kind: x.dst_kind,
                p: x.dst_p,
                q: x.dst_q,
                at: x.dst_at,
                gen: x.dst_gen,
            },
            cargo,
        };
        let _ = self.sim.with(|w| w.land_external(sig, &req, u64::MAX));
        Ok(())
    }

    /// Test oracle: lands a transaction the scripted chain holds, by its
    /// signature, without telling the run anything (models "the chain has
    /// it" when the gateway's answer named no signature).
    pub fn land_from_chain(&self, sig: &str) -> Result<(), String> {
        self.land(sig)
    }

    fn remember(&self, key: &str, r: GatewayResult) {
        if let GatewayResult::Sent(s) = &r {
            if let Err(e) = self.land(&s.signature) {
                // Recorded as a send we cannot place: the run will not
                // attribute it (content check) and holds.
                eprintln!("gateway port: {e}");
            }
        }
        self.results.lock().unwrap().insert(key.to_string(), r);
    }

    /// The gateway's fate read for `key` (`GET /fate?key=` on the bridge,
    /// `GET /f/agent/fate?id=&key=` on the gateway). `Err`: the read itself
    /// failed (the gateway could not be reached).
    fn fate(&self, key: &str) -> Result<AttemptFacts, PortError> {
        let (code, v) = http(self.port, "GET", &format!("/fate?key={key}"), None)
            .map_err(PortError::Unavailable)?;
        if code != 200 || !v["state"].is_string() {
            return Err(PortError::Unavailable(format!(
                "fate read answered {code}: {v}"
            )));
        }
        Ok(AttemptFacts {
            state: v["state"].as_str().unwrap_or_default().to_string(),
            signed: signed_of(&v),
            commitment: v["commitment"].as_str().map(str::to_string),
            why: v["why"].as_str().unwrap_or_default().to_string(),
        })
    }

    /// One attempt's facts for a receipt: what the gateway said when it
    /// answered, then the chain's word by the gateway's fate read. `None`:
    /// the handle is not a gateway attempt.
    pub fn facts(&self, handle: &str) -> Option<AttemptFacts> {
        let (_, key) = parse_handle(handle)?;
        let known = self.result_of(key).ok().flatten();
        match known {
            None => Some(AttemptFacts {
                state: "unqueryable".into(),
                signed: None,
                commitment: None,
                why: "the gateway has no answer under this key yet".into(),
            }),
            Some(GatewayResult::Refused { code }) => Some(AttemptFacts {
                state: "not-sent".into(),
                signed: None,
                commitment: None,
                why: format!("refused before signing ({code})"),
            }),
            Some(r) => Some(match self.fate(key) {
                Ok(f) => f,
                Err(PortError::Unavailable(e)) => AttemptFacts {
                    state: "unqueryable".into(),
                    signed: r.signed().cloned(),
                    commitment: None,
                    why: e,
                },
            }),
        }
    }

    /// The gateway's answer for `key`, from this process's memory, else
    /// from the agent's public history (read-only).
    fn result_of(&self, key: &str) -> Result<Option<GatewayResult>, PortError> {
        if let Some(r) = self.results.lock().unwrap().get(key) {
            return Ok(Some(r.clone()));
        }
        let (_, v) = http(self.port, "GET", "/history", None).map_err(PortError::Unavailable)?;
        let Some(h) = v["history"].as_array() else {
            return Err(PortError::Unavailable(
                "no history in the agent's view".into(),
            ));
        };
        let found = h
            .iter()
            .rev()
            .find(|e| e["key"] == json!(key) && e["status"].is_string())
            .map(|e| match (e["status"].as_str(), signed_of(e)) {
                (Some("sent"), Some(s)) => GatewayResult::Sent(s),
                (Some("refused"), _) => GatewayResult::Refused {
                    code: e["code"].as_str().unwrap_or("refused").to_string(),
                },
                (_, _) => failed_of(e, e["code"].as_str().unwrap_or("failed").to_string()),
            });
        if let Some(r) = &found {
            self.remember(key, r.clone());
        }
        Ok(found)
    }
}

impl Chain for GatewayPort {
    fn slot(&self) -> PortResult<u64> {
        self.sim.slot()
    }
    fn place(&self, p: &PlaceRef) -> PortResult<Option<PlaceView>> {
        self.sim.place(p)
    }
    fn caravan_seq(&self, owner: u64) -> PortResult<u32> {
        self.sim.caravan_seq(owner)
    }
    fn caravan(&self, key: CaravanKey) -> PortResult<Option<CaravanView>> {
        self.sim.caravan(key)
    }
    fn facility_use(&self, key: &str) -> PortResult<Option<FacilityUse>> {
        self.sim.facility_use(key)
    }
    fn caravan_history(&self, key: CaravanKey) -> PortResult<Option<Vec<EventRec>>> {
        self.sim.caravan_history(key)
    }
    fn events(&self, after: u64, limit: usize) -> PortResult<EventPage> {
        self.sim.events(after, limit)
    }

    fn prepare(&self, req: &Request, n: u32) -> PortResult<Prepared> {
        let Request::SendCaravan {
            owner,
            seq,
            src,
            dst,
            cargo,
        } = req
        else {
            // The facility use stays MOCK (no instruction exists).
            return self.sim.prepare(req, n);
        };
        let slot = self.sim.slot()?;
        let key = format!("ws04:{owner:x}:{seq}:{n}");
        let body = self.action(&key, *seq, src, dst, cargo);
        Ok(Prepared {
            sig: format!("gw:{slot}:{key}"),
            request: req.clone(),
            wire: body.to_string().into_bytes(),
            // The gateway picks the blockhash when it sends; not known here.
            valid_until: u64::MAX,
            // The relay's pool pays the network fee (workstream 05 records it).
            fee: 0,
        })
    }

    fn send(&self, p: &Prepared) -> SendResult {
        let Some((_, key)) = parse_handle(&p.sig) else {
            return self.sim.send(p);
        };
        // Only sends from the agent's village are wired here (the gateway
        // also allows the owner's vaults, but this port cannot place their
        // accounts): anything else is refused before any call or signature.
        if let Request::SendCaravan { src, .. } = &p.request {
            if *src != self.village() {
                self.remember(
                    key,
                    GatewayResult::Refused {
                        code: "SourceNotVillage".into(),
                    },
                );
                return SendResult::Rejected(Reject::Refused("SourceNotVillage".into()));
            }
        }
        let Ok(body) = serde_json::from_slice::<Value>(&p.wire) else {
            return SendResult::Unknown("unreadable journalled request".into());
        };
        let fault = self.faults.lock().unwrap().pop_front();
        let mut req = json!({ "request": body });
        if let Some(f) = fault {
            req["fault"] = json!(f);
        }
        let (code, v) = match http(self.port, "POST", "/action", Some(&req)) {
            Ok(x) => x,
            Err(e) => return SendResult::Unknown(e),
        };
        if code != 200 {
            return SendResult::Unknown(format!("gateway answered {code}"));
        }
        match v["status"].as_str() {
            Some("sent") => match signed_of(&v) {
                Some(s) => {
                    self.remember(key, GatewayResult::Sent(s));
                    SendResult::Accepted
                }
                None => SendResult::Unknown("sent without a signature".into()),
            },
            Some("refused") => {
                let c = v["error"]["code"].as_str().unwrap_or("refused").to_string();
                self.remember(key, GatewayResult::Refused { code: c.clone() });
                SendResult::Rejected(Reject::Refused(c))
            }
            Some("failed") => {
                let c = v["error"]["code"].as_str().unwrap_or("failed").to_string();
                let r = failed_of(&v, c.clone());
                let out = match &r {
                    // Nothing left the gateway (a fault on the way, e.g. the
                    // RPC down): not a refusal of the request. The status read
                    // answers Absent, and the executor may try a new attempt.
                    GatewayResult::Failed {
                        signed: None,
                        sent_known: true,
                        ..
                    } => SendResult::Unknown(format!("gateway: failed ({c}) before sending")),
                    GatewayResult::Failed {
                        signed: Some(s), ..
                    } => SendResult::Unknown(format!(
                        "gateway: failed ({c}) after signing {}; the chain decides",
                        s.signature
                    )),
                    _ => SendResult::Unknown(format!(
                        "gateway: failed ({c}), signature not reported"
                    )),
                };
                self.remember(key, r);
                out
            }
            _ => SendResult::Unknown(format!("unexpected answer: {v}")),
        }
    }

    fn status(&self, sig: &str, valid_until: u64) -> PortResult<SigStatus> {
        let Some((prepared_at, key)) = parse_handle(sig) else {
            return self.sim.status(sig, valid_until);
        };
        Ok(match self.result_of(key)? {
            Some(GatewayResult::Refused { .. }) => SigStatus::Absent,
            Some(GatewayResult::Failed {
                signed: None,
                sent_known: true,
                ..
            }) => SigStatus::Absent,
            // An older gateway: a failure without a signature cannot be followed.
            Some(GatewayResult::Failed { signed: None, .. }) => SigStatus::Unavailable,
            Some(r) => {
                let s = r.signed().cloned().unwrap_or_default();
                let f = self.fate(key)?;
                match f.state.as_str() {
                    "landed" | "failed" => {
                        // The chain's effect, in the simulated world (idempotent).
                        let _ = self.land(&s.signature);
                        match self.sim.status(&s.signature, u64::MAX)? {
                            SigStatus::Landed { slot, .. } if f.state == "landed" => {
                                SigStatus::Landed { slot, fee: Some(0) }
                            }
                            SigStatus::Failed { slot, reject, .. } => SigStatus::Failed {
                                slot,
                                fee: Some(0),
                                reject,
                            },
                            _ if f.state == "failed" => SigStatus::Failed {
                                slot: self.sim.slot()?,
                                fee: Some(0),
                                reject: Reject::Other(f.why.clone()),
                            },
                            // Finalized landed on the chain, not placeable here: hold.
                            _ => SigStatus::Unavailable,
                        }
                    }
                    "expired" | "not-sent" => SigStatus::Absent,
                    "pending" => SigStatus::Pending,
                    "unknown" => SigStatus::Unavailable,
                    // `unqueryable` and anything new: the read told us nothing.
                    _ => return Err(PortError::Unavailable(format!("{}: {}", f.state, f.why))),
                }
            }
            None if self.sim.slot()? <= prepared_at + self.lookup_grace => SigStatus::Pending,
            None => SigStatus::Unavailable,
        })
    }

    fn chain_sig(&self, handle: &str) -> Option<String> {
        let Some((_, key)) = parse_handle(handle) else {
            return Some(handle.to_string());
        };
        match self.result_of(key) {
            Ok(Some(r)) => r.signed().map(|s| s.signature.clone()),
            _ => None,
        }
    }
}
