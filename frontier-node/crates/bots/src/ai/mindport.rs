//! The brain's side of the mind API (contract §4.1, §8.1): the wire types
//! of `POST /v1/decide` and `POST /v1/outcome`, their JSON, and a small
//! tokio `TcpStream` HTTP client with an `Authorization` header and a
//! per-call timeout (`fclient::http` has a fixed 20 s timeout and no
//! headers on POST; no new crate).
//!
//! **The wire is pinned by the golden fixture**
//! `permutation-gateway/test/fixtures/ai-decide-v1.json`. One producer
//! (`bots/tests/ai_wire.rs` with `AI_WRITE_VECTORS=1`), one freshness
//! checker (the same test without the flag), and the Node schema test
//! (`citizens-mind-schema.test.mjs`) validates the same file.
//!
//! Pinned conventions (the contract's examples are illustrative where they
//! differ; AC3a-NOTES.md lists them):
//! - every u64 id (`host_id`) travels as a **decimal string**, as the
//!   herald serves them: real host ids are `(province_index << 44) | …`
//!   and do not survive a JSON number in Node;
//! - `ai.tag` is the Citizen's `citizen_tag` as 16 lowercase hex digits of
//!   the u64 (`format!("{:016x}")`, the web's `tagKey`);
//! - a candidate `kind` is the contract's table entry verbatim:
//!   `autopilot`, `hold`, `march`, `recall:<handle>`, `build:<item>`,
//!   `walls`, `train:<unit>`, `muster:<unit>`, `explore:<handle>`;
//! - numbers are whole numbers except `scale`.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::standing::Standing;

/// The wire version of `/v1/decide` and `/v1/outcome`.
pub const WIRE_V: u32 = 1;

/// Why a mind call produced no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MindError {
    /// No time left before the deadline (the brain never calls then).
    NoTime,
    /// Connect, write, read or timeout.
    Transport(String),
    /// Not HTTP 200 (status, short body).
    Status(u16, String),
    /// The body is not a decision answer.
    Bad(String),
}

impl std::fmt::Display for MindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MindError::NoTime => write!(f, "no_time"),
            MindError::Transport(e) => write!(f, "transport: {e}"),
            MindError::Status(s, b) => write!(f, "status {s}: {b}"),
            MindError::Bad(e) => write!(f, "bad answer: {e}"),
        }
    }
}

// ------------------------------------------------------------------ wire

/// One candidate of §4.3 (≤ 12 per request, ids `c1..c12`).
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub kind: String,
    pub label: String,
    /// A JSON object of numbers, strings and booleans.
    pub facts: Value,
    /// Allowed values per parameter name.
    pub params: BTreeMap<String, Vec<Value>>,
    /// `council: true` marks the Strike-Order march (AC3b).
    pub council: bool,
    pub troops: Option<u32>,
    pub entities: Vec<String>,
}

impl Candidate {
    pub fn to_json(&self) -> Value {
        let params: Map<String, Value> = self
            .params
            .iter()
            .map(|(k, v)| (k.clone(), Value::Array(v.clone())))
            .collect();
        let mut o = Map::new();
        o.insert("id".into(), json!(self.id));
        o.insert("kind".into(), json!(self.kind));
        o.insert("label".into(), json!(self.label));
        o.insert("facts".into(), self.facts.clone());
        o.insert("params".into(), Value::Object(params));
        let mut flags = Map::new();
        if self.council {
            flags.insert("council".into(), json!(true));
        }
        o.insert("flags".into(), Value::Object(flags));
        if let Some(t) = self.troops {
            o.insert("troops".into(), json!(t));
        }
        o.insert("entities".into(), json!(self.entities));
        Value::Object(o)
    }
}

/// Where an own march ended, once public (`own_marches[].opened`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    /// The seal outcome of `/h/me` `seals` (`outcome`, `code`), if settled.
    pub seal: Option<(u8, u8)>,
}

/// One own march of the marchbook (§4.1 `own_marches`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnMarch {
    pub host_id: u64,
    pub troops_at_depart: u32,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    /// `None` until the arrival bell has ended and the destination is
    /// public; never filled by the brain before.
    pub opened: Option<Opened>,
}

impl OwnMarch {
    pub fn to_json(&self) -> Value {
        let opened = match &self.opened {
            None => Value::Null,
            Some(o) => {
                let mut v = json!({"p": o.p, "q": o.q, "tile": o.tile});
                if let Some((outcome, code)) = o.seal {
                    v["seal"] = json!({"outcome": outcome, "code": code});
                }
                v
            }
        };
        json!({
            "host_id": self.host_id.to_string(),
            "troops_at_depart": self.troops_at_depart,
            "depart_bell": self.depart_bell,
            "arrive_bell": self.arrive_bell,
            "opened": opened,
        })
    }
}

/// A Strike-Order follow march the autopilot would send (`autopilot.departs`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FollowDepart {
    pub host_id: u64,
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    pub arrive_bell: u32,
}

/// The autopilot's summary (§4.1 `autopilot`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutopilotSummary {
    pub summary: String,
    pub has_military: bool,
    pub departs: Vec<FollowDepart>,
}

impl AutopilotSummary {
    pub fn to_json(&self) -> Value {
        json!({
            "summary": self.summary,
            "has_military": self.has_military,
            "departs": self.departs.iter().map(|d| json!({
                "host_id": d.host_id.to_string(), "p": d.p, "q": d.q, "tile": d.tile,
                "arrive_bell": d.arrive_bell, "via": "strike_order",
            })).collect::<Vec<_>>(),
        })
    }
}

/// Who is asking.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiRef {
    pub index: u32,
    pub wallet: String,
    /// The Citizen's `citizen_tag` as 16 hex digits.
    pub tag: String,
}

/// `POST /v1/decide` body (§4.1).
#[derive(Clone, Debug, PartialEq)]
pub struct DecideRequest {
    pub ai: AiRef,
    pub bell: u32,
    pub now_game: i64,
    pub scale: f64,
    pub deadline_unix_ms: u64,
    pub wake_hints: Vec<String>,
    pub obs_digest: String,
    pub situation: Value,
    pub candidates: Vec<Candidate>,
    pub own_marches: Vec<OwnMarch>,
    pub autopilot: AutopilotSummary,
}

/// `scale` as a JSON number: an integer when whole, else 3 decimals.
pub fn scale_json(s: f64) -> Value {
    if s.fract() == 0.0 && s.abs() < 1e9 {
        json!(s as i64)
    } else {
        json!((s * 1000.0).round() / 1000.0)
    }
}

impl DecideRequest {
    pub fn to_json(&self) -> Value {
        json!({
            "v": WIRE_V,
            "ai": {"index": self.ai.index, "wallet": self.ai.wallet, "tag": self.ai.tag},
            "bell": self.bell,
            "now_game": self.now_game,
            "scale": scale_json(self.scale),
            "deadline_unix_ms": self.deadline_unix_ms,
            "wake_hints": self.wake_hints,
            "obs_digest": self.obs_digest,
            "situation": self.situation,
            "candidates": self.candidates.iter().map(Candidate::to_json).collect::<Vec<_>>(),
            "own_marches": self.own_marches.iter().map(OwnMarch::to_json).collect::<Vec<_>>(),
            "autopilot": self.autopilot.to_json(),
        })
    }
}

/// The mind's mode for this step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Model,
    Autopilot,
}

/// `POST /v1/decide` answer (§8.1). `social` is not used by the brain in
/// AC3a (AC3b signs and posts it).
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub decision_id: String,
    pub mode: Mode,
    pub reason: String,
    pub ids: Vec<String>,
    /// Params per chosen candidate id (a JSON object each).
    pub params: BTreeMap<String, Value>,
    pub mem: Vec<String>,
    pub standing: Standing,
    pub social: Value,
}

fn u64_of(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

pub(crate) fn id_of(v: &Value) -> Option<u64> {
    u64_of(v)
}

impl Answer {
    pub fn from_json(v: &Value) -> Result<Answer, MindError> {
        let bad = |m: &str| MindError::Bad(m.to_string());
        if v.get("v").and_then(Value::as_u64) != Some(WIRE_V as u64) {
            return Err(bad("v != 1"));
        }
        let decision_id = v
            .get("decision_id")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("decision_id"))?
            .to_string();
        let mode = match v.get("mode").and_then(Value::as_str) {
            Some("model") => Mode::Model,
            Some("autopilot") => Mode::Autopilot,
            _ => return Err(bad("mode")),
        };
        let reason = v
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let choice = v.get("choice").cloned().unwrap_or(Value::Null);
        let ids: Vec<String> = choice
            .get("ids")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let mut params = BTreeMap::new();
        if let Some(o) = choice.get("params").and_then(Value::as_object) {
            for (k, p) in o {
                params.insert(k.clone(), p.clone());
            }
        }
        let mem: Vec<String> = choice
            .get("mem")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        if mode == Mode::Model && ids.is_empty() {
            return Err(bad("model mode without a choice"));
        }
        let standing = Standing::from_wire(
            v.get("standing").unwrap_or(&Value::Null),
            v.get("caps").unwrap_or(&Value::Null),
        );
        Ok(Answer {
            decision_id,
            mode,
            reason,
            ids,
            params,
            mem,
            standing,
            social: v.get("social").cloned().unwrap_or(Value::Null),
        })
    }
}

/// One action of a step as `POST /v1/outcome` reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionOutcome {
    pub intent: String,
    pub sig: Option<String>,
    pub ok: bool,
    pub code: Option<String>,
}

impl ActionOutcome {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("intent".into(), json!(self.intent));
        if let Some(s) = &self.sig {
            o.insert("sig".into(), json!(s));
        }
        o.insert(
            "status".into(),
            json!(if self.ok { "sent" } else { "refused" }),
        );
        if let Some(c) = &self.code {
            o.insert("code".into(), json!(c));
        }
        Value::Object(o)
    }
}

/// `POST /v1/outcome` body (§8.1).
pub fn outcome_json(decision_id: &str, actions: &[ActionOutcome], own: &[OwnMarch]) -> Value {
    json!({
        "decision_id": decision_id,
        "actions": actions.iter().map(ActionOutcome::to_json).collect::<Vec<_>>(),
        "own_marches": own.iter().map(OwnMarch::to_json).collect::<Vec<_>>(),
    })
}

/// `POST /v1/brain-stats` body (AC10a, R5/R6): the CUMULATIVE counters of one AI bot (`steps`, `no_session`, `gets:*`, ...).
pub fn brain_stats_json(
    index: u32,
    bell: u32,
    counters: &std::collections::BTreeMap<String, u64>,
) -> Value {
    json!({"v": WIRE_V, "index": index, "bell": bell, "counters": counters})
}

// ------------------------------------------------------------------ client

/// The keyless mind on loopback.
#[derive(Clone, Debug)]
pub struct MindPort {
    /// `127.0.0.1:41980`.
    pub addr: String,
    pub token: String,
}

/// `http://127.0.0.1:<port>` (or `localhost`) → `host:port`; anything else
/// is refused (loopback only, the contract's §1.1 port rule).
pub fn parse_mind_url(u: &str) -> Option<String> {
    let rest = u.strip_prefix("http://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains(['@', '\\', '%']) || authority.chars().any(char::is_whitespace) {
        return None;
    }
    let (host, port) = authority.rsplit_once(':')?;
    if !matches!(host, "127.0.0.1" | "localhost")
        || port.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let n: u16 = port.parse().ok()?;
    Some(format!("{host}:{n}"))
}

impl MindPort {
    pub fn new(addr: impl Into<String>, token: impl Into<String>) -> MindPort {
        MindPort {
            addr: addr.into(),
            token: token.into(),
        }
    }

    /// POST `body` to `path`: (status, body bytes), within `timeout`.
    pub async fn post(
        &self,
        path: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<(u16, Vec<u8>), MindError> {
        if timeout < Duration::from_millis(500) {
            return Err(MindError::NoTime);
        }
        let payload =
            serde_json::to_vec(body).map_err(|e| MindError::Transport(format!("encode: {e}")))?;
        let addr = self.addr.clone();
        let token = self.token.clone();
        let path = path.to_string();
        let run = async move {
            let mut s = TcpStream::connect(&addr)
                .await
                .map_err(|e| MindError::Transport(format!("connect: {e}")))?;
            let head = format!(
                "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            s.write_all(head.as_bytes())
                .await
                .map_err(|e| MindError::Transport(format!("write: {e}")))?;
            s.write_all(&payload)
                .await
                .map_err(|e| MindError::Transport(format!("write: {e}")))?;
            let mut raw = vec![];
            s.read_to_end(&mut raw)
                .await
                .map_err(|e| MindError::Transport(format!("read: {e}")))?;
            parse_response(&raw)
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(r) => r,
            Err(_) => Err(MindError::Transport("timeout".into())),
        }
    }

    /// `POST /v1/decide`.
    pub async fn decide(
        &self,
        req: &DecideRequest,
        timeout: Duration,
    ) -> Result<Answer, MindError> {
        let (status, body) = self.post("/v1/decide", &req.to_json(), timeout).await?;
        if status != 200 {
            return Err(MindError::Status(status, short(&body)));
        }
        let v: Value =
            serde_json::from_slice(&body).map_err(|e| MindError::Bad(format!("json: {e}")))?;
        Answer::from_json(&v)
    }

    /// `POST /v1/brain-stats`.
    pub async fn brain_stats(&self, body: &Value, timeout: Duration) -> Result<(), MindError> {
        let (status, b) = self.post("/v1/brain-stats", body, timeout).await?;
        if status == 200 {
            Ok(())
        } else {
            Err(MindError::Status(status, short(&b)))
        }
    }

    /// `POST /v1/outcome`.
    pub async fn outcome(&self, body: &Value, timeout: Duration) -> Result<(), MindError> {
        let (status, b) = self.post("/v1/outcome", body, timeout).await?;
        if status == 200 {
            Ok(())
        } else {
            Err(MindError::Status(status, short(&b)))
        }
    }
}

fn short(b: &[u8]) -> String {
    String::from_utf8_lossy(&b[..b.len().min(120)]).to_string()
}

/// An HTTP/1.1 response read to EOF: status and the de-chunked body.
pub fn parse_response(raw: &[u8]) -> Result<(u16, Vec<u8>), MindError> {
    let bad = |m: &str| MindError::Transport(format!("response: {m}"));
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| bad("no header end"))?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| bad("header utf8"))?;
    let body = &raw[split + 4..];
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| bad("status line"))?;
    let chunked = lines.any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if !chunked {
        return Ok((status, body.to_vec()));
    }
    let mut out = vec![];
    let mut rest = body;
    loop {
        let eol = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| bad("chunk size"))?;
        let size = std::str::from_utf8(&rest[..eol])
            .ok()
            .and_then(|s| usize::from_str_radix(s.split(';').next().unwrap_or("").trim(), 16).ok())
            .ok_or_else(|| bad("chunk size"))?;
        rest = &rest[eol + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size + 2 {
            return Err(bad("short chunk"));
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
    Ok((status, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mind_urls_are_loopback_only() {
        assert_eq!(
            parse_mind_url("http://127.0.0.1:41980"),
            Some("127.0.0.1:41980".into())
        );
        assert_eq!(
            parse_mind_url("http://localhost:41980/x"),
            Some("localhost:41980".into())
        );
        for bad in [
            "https://127.0.0.1:1",
            "http://127.0.0.2:1",
            "http://127.0.0.1",
            "http://127.0.0.1:1@evil/",
            "http://example.com:80",
            "http://127.0.0.1:99999",
        ] {
            assert_eq!(parse_mind_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn responses_parse_plain_and_chunked() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(parse_response(plain).unwrap(), (200, b"{}".to_vec()));
        let chunked =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n3\r\n\":1\r\n1\r\n}\r\n0\r\n\r\n";
        assert_eq!(
            parse_response(chunked).unwrap(),
            (200, b"{\"a\":1}".to_vec())
        );
        assert!(parse_response(b"garbage").is_err());
    }

    #[test]
    fn scale_is_an_integer_when_whole() {
        assert_eq!(scale_json(10.0), json!(10));
        assert_eq!(scale_json(9.9876), json!(9.988));
    }
}
