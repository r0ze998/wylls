//! The keeper's loopback API (M1 contract §8.2; skeleton in W2-F).
//!
//! Bound to a loopback address only; every route needs `Authorization:
//! Bearer <token>` (the token file the relay shares, like the gateway's
//! operator token).
//!
//! | route | W2-F |
//! |---|---|
//! | `GET /v1/status` | duties, pools, spend, latencies: the snapshot of the last tick, published after its sends (W6T-2: never taken away while a tick runs) |
//! | `GET /metrics` | Prometheus text (live) |
//! | `POST /v1/reveal` | shape checks (`400`), plaintext rules (`422 BadPlaintext`), then (W3-C) the accept path against chain ([`crate::reveal_accept`]: `409 CommitMismatch` / `TransitState` / `ArrivalBell` / `Shielded` (W6T-2), `410 WindowClosed`, `422 BadPlaintext` against the transit; every refusal body is `{error, code, detail}`), then queued with a track id (`202`; the same material again answers the same track, before any chain read; verify-pr166: so does material opening an already acknowledged live DEPART's seal root under another `holding` / `transit_slot`). fix-gw-highs (audit H-1): before the gate, material that opens no live DEPART the play index holds is `503 RevealNotIndexed` (`409 CommitMismatch` for another host's or bell's root) once the index is caught up, at zero RPC; the gate's reads take the external budget's tokens ([`crate::api_guard`]): spent, `503 KeeperBusy`, except for indexed material, which is queued unchecked. W4-C's pipeline ([`crate::play`]) sends it from the bell start and moves the track: `sent`, `landed` (signature, slot), `refused` (`QuotaRefused`), `expired` (`WindowClosed`) |
//! | `POST /v1/nudge` | fix-gw-highs (audit H-2): `{province: [P, Q] (i16), bell (u32)}`; `422 BellOutOfRange` past the current bell + 2, `404 UnknownProvince` for a province the caught-up index does not know, one queued per province (a later bell replaces nothing it covers), `503 KeeperBusy` past 1,024 queued; otherwise queued; the province is caught up at once (W4-C); `blocking` lists what holds it now (`[{kind, key}]`: its lag, writes in flight on it, departures waiting for its resolve), as of the last tick |
//! | `GET /v1/track/{id}` | the track's state |

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use serde_json::{json, Value};

use crate::api_guard::SealCheck;
use crate::reveal_accept::{RevealGate, RevealReq};
use crate::Shared;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Clone)]
struct ApiState {
    shared: Arc<Mutex<Shared>>,
    token: Arc<String>,
    /// The accept path against chain (W3-C); `None` queues after the shape
    /// checks only (unit tests of the routes).
    gate: Option<Arc<dyn RevealGate>>,
    /// The keeper's journal (⑱): accepted material is written there before
    /// `202` is answered, so a restart before the play duty takes it from
    /// the queue loses nothing. `None` keeps it in memory (unit tests).
    journal: Option<Arc<std::path::PathBuf>>,
}

fn lock(s: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    s.lock().unwrap_or_else(|p| p.into_inner())
}

fn authorized(st: &ApiState, h: &HeaderMap) -> bool {
    let want = format!("Bearer {}", st.token);
    h.get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            // constant-time over the header length
            v.len() == want.len()
                && v.bytes()
                    .zip(want.bytes())
                    .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                    == 0
        })
}

/// A refusal body: `{"error": name, "code": name, "detail": …}` (`error`
/// is the relay's field, W6T-2; `code` the W2-F one).
fn err(code: StatusCode, name: &str, detail: &str) -> Response {
    (
        code,
        Json(json!({"error": name, "code": name, "detail": detail})),
    )
        .into_response()
}

async fn status(State(st): State<ApiState>, h: HeaderMap) -> Response {
    if !authorized(&st, &h) {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized", "bearer token");
    }
    let s = lock(&st.shared);
    let mut v = s.status.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("api".into(), crate::api_guard::status(&s.api));
    }
    Json(v).into_response()
}

async fn metrics(State(st): State<ApiState>, h: HeaderMap) -> Response {
    if !authorized(&st, &h) {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized", "bearer token");
    }
    ([("content-type", "text/plain; version=0.0.4")], {
        let s = lock(&st.shared);
        format!("{}{}", s.metrics, crate::api_guard::metrics(&s.api))
    })
        .into_response()
}

fn b64_len(v: &Value, k: &str, n: usize) -> Result<Vec<u8>, String> {
    let s = v
        .get(k)
        .and_then(|x| x.as_str())
        .ok_or(format!("missing `{k}`"))?;
    let b = B64.decode(s).map_err(|_| format!("`{k}` is not base64"))?;
    if b.len() != n {
        return Err(format!("`{k}` must be {n} bytes, got {}", b.len()));
    }
    Ok(b)
}

/// Checks the owner reveal material of `POST /v1/reveal` (§8.2).
pub fn check_reveal(v: &Value) -> Result<(), (StatusCode, &'static str, String)> {
    let bad = |d: String| (StatusCode::BAD_REQUEST, "BadRequest", d);
    v.get("holding")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<solana_address::Address>().ok())
        .ok_or_else(|| bad("`holding` must be a base58 address".into()))?;
    let slot = v
        .get("transit_slot")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| bad("missing `transit_slot`".into()))?;
    if slot >= fclient::abi::TRANSIT_SLOTS as u64 {
        return Err(bad("`transit_slot` must be 0-3".into()));
    }
    let plain = b64_len(v, "plain_b64", fclient::seal::PLAIN_LEN).map_err(bad)?;
    b64_len(v, "salt_b64", 32).map_err(bad)?;
    b64_len(v, "ct_hash_b64", 32).map_err(bad)?;
    let p = fclient::seal::unpack(&plain.try_into().expect("37"));
    // The rules of I-28 that need no chain read (host and arrive are the
    // plaintext's own here; W3-C checks them against the transit record).
    fclient::seal::validate(&p, p.host_id, p.arrive_bell).map_err(|e| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "BadPlaintext",
            format!("{e:?}"),
        )
    })
}

/// The request's material as the accept path takes it (shape already checked).
fn reveal_req(v: &Value) -> Option<RevealReq> {
    let b = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .and_then(|s| B64.decode(s).ok())
    };
    Some(RevealReq {
        holding: v.get("holding")?.as_str()?.parse().ok()?,
        transit_slot: v.get("transit_slot")?.as_u64()? as u8,
        plain: b("plain_b64")?.try_into().ok()?,
        salt: b("salt_b64")?.try_into().ok()?,
        ct_hash: b("ct_hash_b64")?.try_into().ok()?,
    })
}

async fn reveal(State(st): State<ApiState>, h: HeaderMap, Json(v): Json<Value>) -> Response {
    if !authorized(&st, &h) {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized", "bearer token");
    }
    if let Err((c, name, d)) = check_reveal(&v) {
        api_count(&st, "reveal_refused_shape", true);
        return err(c, name, &d);
    }
    let Some(req) = reveal_req(&v) else {
        return err(StatusCode::BAD_REQUEST, "BadRequest", "reveal material");
    };
    let dedupe = format!(
        "{}:{}:{}",
        req.holding,
        req.transit_slot,
        hex::encode(fclient::seal::commit(&req.plain, &req.salt))
    );
    // The same material byte for byte (with its ct_hash: another ct_hash
    // must still meet the gate's CommitMismatch).
    let exact = format!("{dedupe}:{}", hex::encode(req.ct_hash));
    // Before any chain read (fix-gw-highs, audit H-1): the journal's tracks,
    // the same material again, a full queue, and the zero-RPC seal check
    // against the play index's live DEPARTs.
    let seal = {
        let mut s = lock(&st.shared);
        if s.feed_paused {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "DiscoveryUnavailable",
                "keeper discovery is incomplete or unsupported; automatic game writes are paused",
            );
        }
        if let Err(r) = restore_once(&st, &mut s) {
            return r;
        }
        if let Some(id) = s.reveal_keys.get(&exact).cloned() {
            crate::api_guard::count(&mut s.api, "reveal_deduped", false);
            return (
                StatusCode::ACCEPTED,
                Json(json!({"accepted": true, "track": id})),
            )
                .into_response();
        }
        let seal = s.admission.as_ref().map(|a| a.seal(&req));
        // verify-pr166: material that opens a live DEPART already acknowledged
        // under another holding / transit slot (revealed material is public
        // after its round: anyone can resubmit it with a forged holding) gets
        // the march's track, before the queue, the gate and the journal; one
        // acknowledgement per seal root.
        if seal == Some(SealCheck::Indexed) {
            if let Some(id) = s.reveal_keys.get(&seal_key(&req)).cloned() {
                crate::api_guard::count(&mut s.api, "reveal_deduped", false);
                return (
                    StatusCode::ACCEPTED,
                    Json(json!({"accepted": true, "track": id})),
                )
                    .into_response();
            }
        }
        if s.reveals.len() >= crate::api_guard::REVEAL_QUEUE_MAX {
            crate::api_guard::count(&mut s.api, "reveal_busy_queue", true);
            let b = crate::api_guard::busy();
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                b.code,
                "the reveal queue is full",
            );
        }
        match seal {
            Some(SealCheck::Mismatch) => {
                crate::api_guard::count(&mut s.api, "reveal_refused_mismatch", true);
                return err(
                    StatusCode::CONFLICT,
                    "CommitMismatch",
                    "the material opens a departure of another host or arrival bell",
                );
            }
            Some(SealCheck::Unknown { ready: true }) => {
                crate::api_guard::count(&mut s.api, "reveal_refused_unindexed", true);
                // 503 (not 409): a Depart that landed a moment ago may not be
                // indexed yet; the page asks again 60 s later.
                return err(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "RevealNotIndexed",
                    "no live departure this keeper indexed has this seal root",
                );
            }
            _ => {}
        }
        seal
    };
    let indexed = seal == Some(SealCheck::Indexed);
    let mut item = v.clone();
    if let Some(g) = &st.gate {
        match g.check(&req).await {
            Ok(a) => {
                item["checked"] = json!(true);
                item["host_id"] = json!(a.host_id.to_string());
                item["faction"] = json!(a.faction);
                item["arrive"] = json!(a.arrive);
                item["dest"] = json!([a.dest.0, a.dest.1]);
                item["tile"] = json!(a.tile);
                item["region"] = json!(a.region);
                item["commit_hex"] = json!(hex::encode(a.commit));
                item["close"] = json!(a.close);
            }
            // The external budget is spent, but the material opens a live
            // DEPART's seal root (only its owner can have it): queued
            // unchecked; the play duty judges it against the chain before
            // it sends, as it does every owner material.
            Err(r) if r.code == "KeeperBusy" && indexed => {
                item["checked"] = json!(false);
                item["seal_indexed"] = json!(true);
                api_count(&st, "reveal_accepted_unchecked", false);
            }
            Err(r) => {
                api_count(&st, &format!("reveal_refused_{}", r.code), true);
                let code = StatusCode::from_u16(r.http).unwrap_or(StatusCode::CONFLICT);
                return err(code, r.code, &r.detail);
            }
        }
    } else {
        item["checked"] = json!(false);
    }
    let mut s = lock(&st.shared);
    if s.feed_paused {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "DiscoveryUnavailable",
            "keeper discovery is incomplete or unsupported; automatic game writes are paused",
        );
    }
    if let Err(r) = restore_once(&st, &mut s) {
        return r;
    }
    if let Some(id) = s.reveal_keys.get(&dedupe).cloned() {
        crate::api_guard::count(&mut s.api, "reveal_deduped", false);
        return (
            StatusCode::ACCEPTED,
            Json(json!({"accepted": true, "track": id})),
        )
            .into_response();
    }
    s.next_track += 1;
    let id = format!("r{}", s.next_track);
    if let Some(path) = &st.journal {
        // Durable before it is acknowledged (⑱): the material waits for
        // THE anchor and T(arrive), possibly across a restart.
        let p = fclient::seal::unpack(&req.plain);
        let row = crate::journal::OwnerRow {
            host: p.host_id,
            bell: p.arrive_bell,
            track: id.clone(),
            holding: req.holding.to_string(),
            transit_slot: req.transit_slot,
            plain: req.plain.to_vec(),
            salt: req.salt.to_vec(),
            ct_hash: req.ct_hash.to_vec(),
        };
        if crate::journal::Journal::open(path)
            .and_then(|j| j.save_owner_material(&row))
            .is_err()
        {
            s.next_track -= 1;
            // Journal errors can include local filesystem paths. Refuse the
            // request without exposing those details to the API caller.
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "JournalUnavailable",
                "owner material could not be stored",
            );
        }
    }
    crate::api_guard::count(&mut s.api, "reveal_accepted", false);
    s.tracks.insert(id.clone(), json!({"state": "queued"}));
    s.reveal_keys.insert(dedupe, id.clone());
    s.reveal_keys.insert(exact, id.clone());
    if indexed {
        s.reveal_keys.insert(seal_key(&req), id.clone());
    }
    s.reveals.push((id.clone(), item));
    (
        StatusCode::ACCEPTED,
        Json(json!({"accepted": true, "track": id})),
    )
        .into_response()
}

/// What this journal acknowledged before a restart, read once before the
/// first id is given or the first duplicate is answered (⑱); unreadable:
/// refused as a failed write is.
#[allow(clippy::result_large_err)]
fn restore_once(st: &ApiState, s: &mut Shared) -> Result<(), Response> {
    if let (Some(path), false) = (&st.journal, s.owner_tracks_restored) {
        if crate::journal::Journal::open(path)
            .and_then(|j| restore_owner_tracks(s, &j))
            .is_err()
        {
            return Err(err(
                StatusCode::SERVICE_UNAVAILABLE,
                "JournalUnavailable",
                "owner material could not be stored",
            ));
        }
        s.owner_tracks_restored = true;
    }
    Ok(())
}

fn api_count(st: &ApiState, event: &str, refused: bool) {
    crate::api_guard::count(&mut lock(&st.shared).api, event, refused);
}

async fn nudge(State(st): State<ApiState>, h: HeaderMap, Json(v): Json<Value>) -> Response {
    if !authorized(&st, &h) {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized", "bearer token");
    }
    let i16_of = |x: &Value| x.as_i64().and_then(|n| i16::try_from(n).ok());
    let pq = v
        .get("province")
        .and_then(|p| p.as_array())
        .filter(|a| a.len() == 2)
        .and_then(|a| Some((i16_of(&a[0])?, i16_of(&a[1])?)));
    let bell = v
        .get("bell")
        .and_then(|b| b.as_u64())
        .and_then(|b| u32::try_from(b).ok());
    let (Some((p, q)), Some(bell)) = (pq, bell) else {
        api_count(&st, "nudge_refused_shape", true);
        return err(
            StatusCode::BAD_REQUEST,
            "BadRequest",
            "`{province: [P, Q] (i16), bell (u32)}`",
        );
    };
    let mut s = lock(&st.shared);
    if s.feed_paused {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "DiscoveryUnavailable",
            "keeper discovery is incomplete or unsupported; automatic game writes are paused",
        );
    }
    // fix-gw-highs (audit H-2): a bell past now + NUDGE_AHEAD_BELLS held
    // the province's skip at one bell per SkipQuiet until the season's end;
    // a province the index does not know stayed in the map for good.
    let (now_bell, known) = match &s.admission {
        Some(a) => (a.now_bell, !a.ready || a.provinces.contains(&(p, q))),
        None => (None, true),
    };
    if let Some(now) = now_bell {
        if bell > now.saturating_add(crate::api_guard::NUDGE_AHEAD_BELLS) {
            crate::api_guard::count(&mut s.api, "nudge_refused_bell", true);
            return err(
                StatusCode::UNPROCESSABLE_ENTITY,
                "BellOutOfRange",
                &format!(
                    "bell {bell} is more than {} bells past the current bell {now}",
                    crate::api_guard::NUDGE_AHEAD_BELLS
                ),
            );
        }
    }
    if !known {
        crate::api_guard::count(&mut s.api, "nudge_refused_province", true);
        return err(
            StatusCode::NOT_FOUND,
            "UnknownProvince",
            &format!("province ({p}, {q}) is not open"),
        );
    }
    let blocking = s
        .blocking
        .get(&format!("{p},{q}"))
        .cloned()
        .unwrap_or_default();
    let same = |n: &Value| {
        n.get("province")
            .and_then(|x| x.as_array())
            .is_some_and(|a| {
                a.len() == 2 && a[0].as_i64() == Some(p as i64) && a[1].as_i64() == Some(q as i64)
            })
            && n.get("bell")
                .and_then(|b| b.as_u64())
                .is_some_and(|b| b >= bell as u64)
    };
    if s.nudges.iter().any(same) {
        crate::api_guard::count(&mut s.api, "nudge_deduped", false);
        return Json(json!({"queued": true, "blocking": blocking})).into_response();
    }
    if s.nudges.len() >= crate::api_guard::NUDGE_QUEUE_MAX {
        crate::api_guard::count(&mut s.api, "nudge_busy_queue", true);
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "KeeperBusy",
            "the nudge queue is full",
        );
    }
    crate::api_guard::count(&mut s.api, "nudge_queued", false);
    s.nudges.push(json!({"province": [p, q], "bell": bell}));
    Json(json!({"queued": true, "blocking": blocking})).into_response()
}

async fn track(State(st): State<ApiState>, h: HeaderMap, Path(id): Path<String>) -> Response {
    if !authorized(&st, &h) {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized", "bearer token");
    }
    match lock(&st.shared).tracks.get(&id) {
        Some(t) => Json(t.clone()).into_response(),
        None => err(StatusCode::NOT_FOUND, "NotFound", &id),
    }
}

pub fn router(shared: Arc<Mutex<Shared>>, token: String) -> Router {
    router_with(shared, token, None)
}

/// The routes with the accept path of `/v1/reveal` behind `gate`.
pub fn router_with(
    shared: Arc<Mutex<Shared>>,
    token: String,
    gate: Option<Arc<dyn RevealGate>>,
) -> Router {
    router_full(shared, token, gate, None)
}

/// [`router_with`] that journals accepted reveal material before `202`.
pub fn router_full(
    shared: Arc<Mutex<Shared>>,
    token: String,
    gate: Option<Arc<dyn RevealGate>>,
    journal: Option<std::path::PathBuf>,
) -> Router {
    let st = ApiState {
        shared,
        token: Arc::new(token),
        gate,
        journal: journal.map(Arc::new),
    };
    Router::new()
        .route("/v1/status", get(status))
        .route("/metrics", get(metrics))
        .route("/v1/reveal", post(reveal))
        .route("/v1/nudge", post(nudge))
        .route("/v1/track/{id}", get(track))
        .with_state(st)
}

/// A running API server.
pub struct Running {
    pub addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl Running {
    pub fn stop(self) {
        self.task.abort();
    }
}

/// Serves on `addr`, which must be a loopback address (port 0 for tests).
pub async fn serve(
    addr: SocketAddr,
    shared: Arc<Mutex<Shared>>,
    token: String,
) -> Result<Running, String> {
    serve_with(addr, shared, token, None).await
}

/// [`serve`] with the `/v1/reveal` accept path against chain.
pub async fn serve_with(
    addr: SocketAddr,
    shared: Arc<Mutex<Shared>>,
    token: String,
    gate: Option<Arc<dyn RevealGate>>,
) -> Result<Running, String> {
    serve_full(addr, shared, token, gate, None).await
}

/// [`serve_with`] with the keeper's journal: accepted reveal material is
/// journalled before `202` (⑱).
pub async fn serve_full(
    addr: SocketAddr,
    shared: Arc<Mutex<Shared>>,
    token: String,
    gate: Option<Arc<dyn RevealGate>>,
    journal: Option<std::path::PathBuf>,
) -> Result<Running, String> {
    if !addr.ip().is_loopback() {
        return Err(format!("the keeper API binds loopback only, not {addr}"));
    }
    if token.len() < 16 {
        return Err("the API token must be at least 16 characters".into());
    }
    let l = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    let addr = l.local_addr().map_err(|e| e.to_string())?;
    let app = router_full(shared, token, gate, journal);
    let task = tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
    });
    Ok(Running { addr, task })
}

/// What `/v1/reveal` acknowledged before a restart (⑱): track ids go on
/// after the highest one journalled (a new march's track never takes the
/// id of a restored one), and the same material answers the track it was
/// journalled under (no second track for one submission).
pub fn restore_owner_tracks(s: &mut Shared, j: &crate::journal::Journal) -> Result<(), String> {
    let n = |t: &str| t.strip_prefix('r').and_then(|x| x.parse::<u64>().ok());
    for (track, _, _) in j.owner_tracks()? {
        if let Some(i) = n(&track) {
            s.next_track = s.next_track.max(i);
        }
    }
    for r in j.owner_materials()? {
        if let Some(i) = n(&r.track) {
            s.next_track = s.next_track.max(i);
        }
        let (Ok(plain), Ok(salt)) = (
            <[u8; 37]>::try_from(r.plain.as_slice()),
            <[u8; 32]>::try_from(r.salt.as_slice()),
        ) else {
            continue;
        };
        let dedupe = format!(
            "{}:{}:{}",
            r.holding,
            r.transit_slot,
            hex::encode(fclient::seal::commit(&plain, &salt))
        );
        if let Ok(ct) = <[u8; 32]>::try_from(r.ct_hash.as_slice()) {
            let root = fclient::seal::seal_root(&fclient::seal::commit(&plain, &salt), &ct);
            s.reveal_keys
                .entry(format!("seal:{}", hex::encode(root)))
                .or_insert(r.track.clone());
        }
        s.reveal_keys.entry(dedupe).or_insert(r.track);
    }
    Ok(())
}

/// The `reveal_keys` key of a material's seal root (verify-pr166).
fn seal_key(req: &RevealReq) -> String {
    let root =
        fclient::seal::seal_root(&fclient::seal::commit(&req.plain, &req.salt), &req.ct_hash);
    format!("seal:{}", hex::encode(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn call(
        addr: SocketAddr,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        let b = body.map(|v| v.to_string()).unwrap_or_default();
        let auth = token
            .map(|t| format!("Authorization: Bearer {t}\r\n"))
            .unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",
            b.len()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = vec![];
        s.read_to_end(&mut out).await.unwrap();
        let text = String::from_utf8_lossy(&out).to_string();
        let code: u16 = text[9..12].parse().unwrap();
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("");
        (code, serde_json::from_str(body).unwrap_or(json!(body)))
    }

    #[tokio::test]
    async fn routes_need_the_token_and_check_shapes() {
        assert!(serve(
            "0.0.0.0:0".parse().unwrap(),
            Default::default(),
            "x".repeat(32)
        )
        .await
        .is_err());
        let shared: Arc<Mutex<Shared>> = Default::default();
        lock(&shared).status = json!({"slot": 5});
        lock(&shared).metrics = "frontier_keeper_slot 5\n".into();
        let tok = "t".repeat(32);
        let r = serve("127.0.0.1:0".parse().unwrap(), shared.clone(), tok.clone())
            .await
            .unwrap();
        let a = r.addr;
        assert_eq!(call(a, "GET", "/v1/status", None, None).await.0, 401);
        assert_eq!(
            call(a, "GET", "/v1/status", Some("wrong"), None).await.0,
            401
        );
        let (c, v) = call(a, "GET", "/v1/status", Some(&tok), None).await;
        assert_eq!((c, &v["slot"]), (200, &json!(5)));
        assert!(v["api"].is_object(), "the API's counters ride along: {v}");
        let (c, v) = call(a, "GET", "/metrics", Some(&tok), None).await;
        assert_eq!(c, 200);
        assert!(v.as_str().unwrap().contains("frontier_keeper_slot 5"));
        // /v1/reveal
        let p = fclient::seal::Plain {
            version: 1,
            host_id: 42,
            arrive_bell: 9,
            stance: 1,
            ..Default::default()
        };
        let good = json!({
            "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
            "transit_slot": 1,
            "plain_b64": B64.encode(fclient::seal::pack(&p)),
            "salt_b64": B64.encode([1u8; 32]),
            "ct_hash_b64": B64.encode([2u8; 32]),
        });
        let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(good.clone())).await;
        assert_eq!(c, 202);
        let id = v["track"].as_str().unwrap().to_string();
        let (c, v) = call(a, "GET", &format!("/v1/track/{id}"), Some(&tok), None).await;
        assert_eq!((c, v["state"].as_str()), (200, Some("queued")));
        // The same material again: the same track, queued once.
        let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(good.clone())).await;
        assert_eq!((c, v["track"].as_str()), (202, Some(id.as_str())));
        let mut short = good.clone();
        short["salt_b64"] = json!(B64.encode([1u8; 31]));
        assert_eq!(
            call(a, "POST", "/v1/reveal", Some(&tok), Some(short))
                .await
                .0,
            400
        );
        let mut bad = good.clone();
        let q = fclient::seal::Plain { stance: 9, ..p };
        bad["plain_b64"] = json!(B64.encode(fclient::seal::pack(&q)));
        let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(bad)).await;
        assert_eq!((c, v["code"].as_str()), (422, Some("BadPlaintext")));
        // /v1/nudge: the blocking set the play duty published (W4-C).
        lock(&shared).blocking.insert(
            "2,-1".into(),
            vec![json!({"kind": "departure", "key": "7:3"})],
        );
        let (c, v) = call(
            a,
            "POST",
            "/v1/nudge",
            Some(&tok),
            Some(json!({"province": [2, -1], "bell": 77})),
        )
        .await;
        assert_eq!((c, v["queued"].as_bool()), (200, Some(true)));
        assert_eq!(v["blocking"][0]["kind"], "departure");
        assert_eq!(lock(&shared).nudges.len(), 1);
        assert_eq!(lock(&shared).reveals.len(), 1);
        assert_eq!(
            call(a, "GET", "/v1/track/nope", Some(&tok), None).await.0,
            404
        );
        r.stop();
    }

    #[tokio::test]
    async fn journal_failure_refuses_without_leaking_or_queueing() {
        let shared: Arc<Mutex<Shared>> = Default::default();
        let tok = "t".repeat(32);
        // An existing directory cannot be opened as the SQLite journal file.
        let journal_dir = std::env::temp_dir();
        let r = serve_full(
            "127.0.0.1:0".parse().unwrap(),
            shared.clone(),
            tok.clone(),
            None,
            Some(journal_dir.clone()),
        )
        .await
        .unwrap();
        let p = fclient::seal::Plain {
            version: 1,
            host_id: 42,
            arrive_bell: 9,
            stance: 1,
            ..Default::default()
        };
        let body = json!({
            "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
            "transit_slot": 1,
            "plain_b64": B64.encode(fclient::seal::pack(&p)),
            "salt_b64": B64.encode([1u8; 32]),
            "ct_hash_b64": B64.encode([2u8; 32]),
        });

        // Repeating the same request must not turn a failed write into a
        // deduplicated 202 or leave an in-memory track behind.
        for _ in 0..2 {
            let (status, response) =
                call(r.addr, "POST", "/v1/reveal", Some(&tok), Some(body.clone())).await;
            assert_eq!(status, 503);
            assert_eq!(
                response,
                json!({
                    "error": "JournalUnavailable",
                    "code": "JournalUnavailable",
                    "detail": "owner material could not be stored",
                })
            );
            assert!(!response
                .to_string()
                .contains(&journal_dir.to_string_lossy().to_string()));
            let state = lock(&shared);
            assert_eq!(state.next_track, 0);
            assert!(state.reveals.is_empty());
            assert!(state.reveal_keys.is_empty());
            assert!(state.tracks.is_empty());
        }
        r.stop();
    }

    #[tokio::test]
    async fn a_restart_keeps_track_ids_and_answers_the_same_material() {
        // ⑱: a second process on the same journal. The same material is
        // answered with the track it was acknowledged under (no second
        // track); another march's track takes an id after every journalled
        // one, never a restored march's id.
        let journal_path = std::env::temp_dir().join(format!(
            "wylls-journal-restart-tracks-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tok = "t".repeat(32);
        let body = |host: u64, salt: u8| {
            let p = fclient::seal::Plain {
                version: 1,
                host_id: host,
                arrive_bell: 9,
                stance: 1,
                ..Default::default()
            };
            json!({
                "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
                "transit_slot": 1,
                "plain_b64": B64.encode(fclient::seal::pack(&p)),
                "salt_b64": B64.encode([salt; 32]),
                "ct_hash_b64": B64.encode([2u8; 32]),
            })
        };
        let post = |addr, b: Value| {
            let tok = tok.clone();
            async move {
                let (c, v) = call(addr, "POST", "/v1/reveal", Some(&tok), Some(b)).await;
                assert_eq!(c, 202, "{v}");
                v["track"].as_str().unwrap().to_string()
            }
        };
        // First process: march 43 twice (two materials: two tracks), march 44.
        {
            let shared: Arc<Mutex<Shared>> = Default::default();
            let r = serve_full(
                "127.0.0.1:0".parse().unwrap(),
                shared,
                tok.clone(),
                None,
                Some(journal_path.clone()),
            )
            .await
            .unwrap();
            assert_eq!(post(r.addr, body(43, 1)).await, "r1");
            assert_eq!(
                post(r.addr, body(43, 1)).await,
                "r1",
                "same material, same track"
            );
            assert_eq!(post(r.addr, body(43, 5)).await, "r2");
            assert_eq!(post(r.addr, body(44, 1)).await, "r3");
            r.stop();
        }
        // Second process.
        let shared: Arc<Mutex<Shared>> = Default::default();
        let r = serve_full(
            "127.0.0.1:0".parse().unwrap(),
            shared.clone(),
            tok.clone(),
            None,
            Some(journal_path.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            post(r.addr, body(43, 5)).await,
            "r2",
            "journalled material: its track"
        );
        assert_eq!(post(r.addr, body(44, 1)).await, "r3");
        assert_eq!(
            post(r.addr, body(45, 1)).await,
            "r4",
            "a new march: after every journalled id"
        );
        assert_eq!(
            lock(&shared).reveals.len(),
            1,
            "only the new material is queued again"
        );
        r.stop();
        let j = crate::journal::Journal::open_existing(&journal_path).unwrap();
        let tracks: Vec<(String, u64)> = j
            .owner_tracks()
            .unwrap()
            .into_iter()
            .map(|(t, h, _)| (t, h))
            .collect();
        assert_eq!(
            tracks,
            vec![
                ("r1".into(), 43),
                ("r2".into(), 43),
                ("r3".into(), 44),
                ("r4".into(), 45)
            ]
        );
        drop(j);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", journal_path.display()));
        }
    }

    #[tokio::test]
    async fn journal_write_failure_refuses_without_leaking_or_queueing() {
        let journal_path = std::env::temp_dir().join(format!(
            "wylls-journal-write-fail-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Opening and initializing the journal succeeds. Only the later
        // owner-material INSERT fails, with a diagnostic that must stay local.
        crate::journal::Journal::open(&journal_path).unwrap();
        {
            let conn = rusqlite::Connection::open(&journal_path).unwrap();
            conn.execute_batch(
                "CREATE TRIGGER fail_owner_material BEFORE INSERT ON owner_material
                 BEGIN SELECT RAISE(ABORT, 'journal-private-sentinel'); END;",
            )
            .unwrap();
        }
        crate::journal::Journal::open(&journal_path).unwrap();

        let shared: Arc<Mutex<Shared>> = Default::default();
        let tok = "t".repeat(32);
        let r = serve_full(
            "127.0.0.1:0".parse().unwrap(),
            shared.clone(),
            tok.clone(),
            None,
            Some(journal_path.clone()),
        )
        .await
        .unwrap();
        let p = fclient::seal::Plain {
            version: 1,
            host_id: 43,
            arrive_bell: 9,
            stance: 1,
            ..Default::default()
        };
        let body = json!({
            "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
            "transit_slot": 1,
            "plain_b64": B64.encode(fclient::seal::pack(&p)),
            "salt_b64": B64.encode([1u8; 32]),
            "ct_hash_b64": B64.encode([2u8; 32]),
        });
        for _ in 0..2 {
            let (status, response) =
                call(r.addr, "POST", "/v1/reveal", Some(&tok), Some(body.clone())).await;
            assert_eq!(status, 503);
            assert_eq!(
                response,
                json!({
                    "error": "JournalUnavailable",
                    "code": "JournalUnavailable",
                    "detail": "owner material could not be stored",
                })
            );
            let text = response.to_string();
            assert!(!text.contains("journal-private-sentinel"));
            assert!(!text.contains(&journal_path.to_string_lossy().to_string()));
            let state = lock(&shared);
            assert_eq!(state.next_track, 0);
            assert!(state.reveals.is_empty());
            assert!(state.reveal_keys.is_empty());
            assert!(state.tracks.is_empty());
        }
        r.stop();
        let conn = rusqlite::Connection::open(&journal_path).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM owner_material", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        drop(conn);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", journal_path.display()));
        }
    }

    #[tokio::test]
    async fn audit_chain_unavailable_rpc_message_in_response() {
        let port = crate::testkit::FakePort::default();
        *port.rpc_error.lock().unwrap() =
            Some("RPC_PRIVATE_SENTINEL /internal/rpc/endpoint".into());
        let gate = crate::reveal_accept::ChainGate {
            port,
            addrs: fclient::addr::Addresses::new(
                solana_address::Address::new_from_array([1; 32]),
                1,
            ),
        };
        let shared: Arc<Mutex<Shared>> = Default::default();
        let tok = "t".repeat(32);
        let r = serve_with(
            "127.0.0.1:0".parse().unwrap(),
            shared.clone(),
            tok.clone(),
            Some(Arc::new(gate)),
        )
        .await
        .unwrap();
        let p = fclient::seal::Plain {
            version: 1,
            host_id: 42,
            arrive_bell: 9,
            stance: 1,
            ..Default::default()
        };
        let body = json!({
            "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
            "transit_slot": 1,
            "plain_b64": B64.encode(fclient::seal::pack(&p)),
            "salt_b64": B64.encode([1u8; 32]),
            "ct_hash_b64": B64.encode([2u8; 32]),
        });
        let (status, response) = call(r.addr, "POST", "/v1/reveal", Some(&tok), Some(body)).await;
        assert_eq!(status, 503);
        assert_eq!(response["code"], "ChainUnavailable");
        assert_eq!(response["detail"], "chain state unavailable");
        assert!(!response.to_string().contains("RPC_PRIVATE_SENTINEL"));
        assert!(!response.to_string().contains("/internal/rpc/endpoint"));
        assert!(lock(&shared).reveals.is_empty());
        r.stop();
    }

    /// W6T-2: a refusal names its code as `error` (the relay passes the
    /// body through: `409 {"error":"Shielded"}`, `{"error":"ArrivalBell"}`).
    #[tokio::test]
    async fn refusal_bodies_name_the_error() {
        struct Refuse;
        impl RevealGate for Refuse {
            fn check<'a>(
                &'a self,
                _: &'a RevealReq,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<
                                crate::reveal_accept::Accepted,
                                crate::reveal_accept::Refusal,
                            >,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(async {
                    Err(crate::reveal_accept::Refusal {
                        http: 409,
                        code: "Shielded",
                        detail: "own holding shielded".into(),
                    })
                })
            }
        }
        let shared: Arc<Mutex<Shared>> = Default::default();
        let tok = "t".repeat(32);
        let mut running = None;
        for port in 41_101..41_150u16 {
            let a: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
            if let Ok(r) = serve_with(a, shared.clone(), tok.clone(), Some(Arc::new(Refuse))).await
            {
                running = Some(r);
                break;
            }
        }
        let r = running.expect("a free port in 41101-41149");
        let p = fclient::seal::Plain {
            version: 1,
            host_id: 42,
            arrive_bell: 9,
            stance: 1,
            ..Default::default()
        };
        let body = json!({
            "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
            "transit_slot": 1,
            "plain_b64": B64.encode(fclient::seal::pack(&p)),
            "salt_b64": B64.encode([1u8; 32]),
            "ct_hash_b64": B64.encode([2u8; 32]),
        });
        let (c, v) = call(r.addr, "POST", "/v1/reveal", Some(&tok), Some(body)).await;
        assert_eq!(c, 409);
        assert_eq!(v["error"], "Shielded", "{v}");
        assert_eq!(v["code"], "Shielded", "the W3-C field stays");
        assert!(lock(&shared).reveals.is_empty(), "not queued");
        r.stop();
    }

    /// A gate that counts its chain checks and answers `answer`.
    struct Counting {
        calls: std::sync::atomic::AtomicUsize,
        answer: Result<crate::reveal_accept::Accepted, crate::reveal_accept::Refusal>,
    }

    impl RevealGate for Counting {
        fn check<'a>(
            &'a self,
            _req: &'a RevealReq,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<
                            crate::reveal_accept::Accepted,
                            crate::reveal_accept::Refusal,
                        >,
                    > + Send
                    + 'a,
            >,
        > {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let a = self.answer.clone();
            Box::pin(async move { a })
        }
    }

    fn accepted() -> crate::reveal_accept::Accepted {
        crate::reveal_accept::Accepted {
            host_id: 42,
            faction: 1,
            arrive: 9,
            dest: (0, 0),
            tile: 0,
            region: 0,
            commit: [0; 32],
            close: None,
        }
    }

    /// Owner material of host 42 arriving at bell 9 with `salt`, and its seal root.
    fn material(salt: u8) -> (Value, [u8; 32]) {
        let p = fclient::seal::Plain {
            version: 1,
            host_id: 42,
            arrive_bell: 9,
            stance: 1,
            ..Default::default()
        };
        let plain = fclient::seal::pack(&p);
        let root =
            fclient::seal::seal_root(&fclient::seal::commit(&plain, &[salt; 32]), &[2u8; 32]);
        (
            json!({
                "holding": solana_address::Address::new_from_array([3; 32]).to_string(),
                "transit_slot": 1,
                "plain_b64": B64.encode(plain),
                "salt_b64": B64.encode([salt; 32]),
                "ct_hash_b64": B64.encode([2u8; 32]),
            }),
            root,
        )
    }

    fn admission(ready: bool, seals: &[([u8; 32], (u64, u32))]) -> crate::api_guard::Admission {
        crate::api_guard::Admission {
            ready,
            now_bell: Some(100),
            seals: Arc::new(seals.iter().copied().collect()),
            provinces: Arc::new([(2i16, -1i16)].into_iter().collect()),
        }
    }

    /// fix-gw-highs (audit H-1): once the play index is caught up, a reveal
    /// that opens no live DEPART's seal root is refused before any chain
    /// read; the genuine material reaches the gate once, its repeats none.
    #[tokio::test]
    async fn forged_reveals_cost_no_chain_read_once_the_index_is_ready() {
        let (genuine, root) = material(1);
        let shared: Arc<Mutex<Shared>> = Default::default();
        lock(&shared).admission = Some(admission(true, &[(root, (42, 9))]));
        let gate = Arc::new(Counting {
            calls: Default::default(),
            answer: Ok(accepted()),
        });
        let tok = "t".repeat(32);
        let app = router_with(shared.clone(), tok.clone(), Some(gate.clone()));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a = l.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(l, app).await });
        for salt in 2..40u8 {
            let (forged, _) = material(salt);
            let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(forged)).await;
            assert_eq!((c, v["code"].as_str()), (503, Some("RevealNotIndexed")));
        }
        assert_eq!(
            gate.calls.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no chain read for junk"
        );
        let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(genuine.clone())).await;
        assert_eq!(c, 202, "{v}");
        let id = v["track"].clone();
        for _ in 0..5 {
            let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(genuine.clone())).await;
            assert_eq!((c, &v["track"]), (202, &id));
        }
        assert_eq!(
            gate.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "repeats are answered before the gate"
        );
        // The root of a DEPART of another host: refused, no read.
        lock(&shared).admission = Some(admission(true, &[(material(50).1, (43, 9))]));
        let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(material(50).0)).await;
        assert_eq!((c, v["code"].as_str()), (409, Some("CommitMismatch")));
        assert_eq!(gate.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let s = lock(&shared);
        assert_eq!(s.reveals.len(), 1);
        assert_eq!(s.api.events["reveal_refused_unindexed"], 38);
        assert_eq!(s.api.events["reveal_deduped"], 5);
        assert_eq!(s.api.events["reveal_refused_mismatch"], 1);
        drop(s);
        task.abort();
    }

    /// While the index catches up (or before it is published) unknown
    /// material goes to the gate, on the external budget only; once that is
    /// spent, junk is refused `KeeperBusy` without a read, and genuine
    /// material (an indexed seal root) is still queued, unchecked.
    #[tokio::test]
    async fn the_external_budget_caps_gate_reads_and_never_drops_genuine_material() {
        let shared: Arc<Mutex<Shared>> = Default::default();
        lock(&shared).admission = Some(admission(false, &[]));
        let inner = Arc::new(Counting {
            calls: Default::default(),
            answer: Err(crate::reveal_accept::Refusal {
                http: 409,
                code: "TransitState",
                detail: "no Holding at that address".into(),
            }),
        });
        let budget = Arc::new(crate::api_guard::ExternalBudget::new(0.0, 6.0));
        let gate: Arc<dyn RevealGate> = Arc::new(crate::api_guard::BudgetedGate {
            inner: inner.clone(),
            budget,
        });
        let tok = "t".repeat(32);
        let app = router_with(shared.clone(), tok.clone(), Some(gate));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let a = l.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(l, app).await });
        let mut codes = vec![];
        for salt in 2..12u8 {
            let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(material(salt).0)).await;
            codes.push((c, v["code"].as_str().unwrap_or("").to_string()));
        }
        assert_eq!(
            inner.calls.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a burst of two checks: {codes:?}"
        );
        assert_eq!(
            codes
                .iter()
                .filter(|x| x.1 == "KeeperBusy" && x.0 == 503)
                .count(),
            8
        );
        // Caught up, the owner's material: queued although the budget is spent.
        let (genuine, root) = material(1);
        lock(&shared).admission = Some(admission(true, &[(root, (42, 9))]));
        let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(genuine.clone())).await;
        assert_eq!(c, 202, "{v}");
        let id = v["track"].clone();
        assert_eq!(inner.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        // verify-pr166: the same material (public once its round is out) with
        // forged holdings and transit slots: the march's track, nothing more
        // queued or journalled, no read (it bypassed every dedupe before).
        for i in 0..40u8 {
            let mut v2 = genuine.clone();
            v2["holding"] =
                json!(solana_address::Address::new_from_array([100 + i; 32]).to_string());
            v2["transit_slot"] = json!(i % 4);
            let (c, v) = call(a, "POST", "/v1/reveal", Some(&tok), Some(v2)).await;
            assert_eq!((c, &v["track"]), (202, &id), "{v}");
        }
        assert_eq!(inner.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let s = lock(&shared);
        assert_eq!(s.reveals.len(), 1);
        assert_eq!(s.reveals[0].1["checked"], false);
        assert_eq!(s.reveals[0].1["seal_indexed"], true);
        assert_eq!(s.api.events["reveal_refused_KeeperBusy"], 8);
        assert_eq!(s.api.events["reveal_accepted_unchecked"], 1);
        drop(s);
        task.abort();
    }

    /// fix-gw-highs (audit H-2): a nudge past now + 2 bells or for a
    /// province the index does not know is refused; one per province is
    /// queued; the queue is bounded.
    #[tokio::test]
    async fn nudges_are_bounded_to_now_and_known_provinces() {
        let shared: Arc<Mutex<Shared>> = Default::default();
        lock(&shared).admission = Some(admission(true, &[]));
        let tok = "t".repeat(32);
        let r = serve("127.0.0.1:0".parse().unwrap(), shared.clone(), tok.clone())
            .await
            .unwrap();
        let a = r.addr;
        let nudge = |p: i64, q: i64, bell: u64| json!({"province": [p, q], "bell": bell});
        for (body, code, name) in [
            (nudge(2, -1, 4_294_967_295), 422, "BellOutOfRange"),
            (nudge(2, -1, 103), 422, "BellOutOfRange"),
            (nudge(2, -1, 4_294_967_296), 400, "BadRequest"),
            (nudge(40_000, -1, 100), 400, "BadRequest"),
            (nudge(9, 9, 100), 404, "UnknownProvince"),
        ] {
            let (c, v) = call(a, "POST", "/v1/nudge", Some(&tok), Some(body.clone())).await;
            assert_eq!((c, v["code"].as_str()), (code, Some(name)), "{body}");
        }
        assert!(lock(&shared).nudges.is_empty());
        // The page's nudges: the province's resolvedNext (behind) and now + 2.
        for bell in [37, 102, 102, 90] {
            let (c, _) = call(a, "POST", "/v1/nudge", Some(&tok), Some(nudge(2, -1, bell))).await;
            assert_eq!(c, 200);
        }
        assert_eq!(
            lock(&shared).nudges.len(),
            2,
            "37, then 102; the repeats and 90 are covered"
        );
        // Catching up: provinces are not judged, the bell still is.
        lock(&shared).admission = Some(admission(false, &[]));
        let (c, _) = call(a, "POST", "/v1/nudge", Some(&tok), Some(nudge(9, 9, 100))).await;
        assert_eq!(c, 200);
        {
            let mut s = lock(&shared);
            while s.nudges.len() < crate::api_guard::NUDGE_QUEUE_MAX {
                s.nudges.push(json!({"province": [1, 1], "bell": 1}));
            }
        }
        let (c, v) = call(a, "POST", "/v1/nudge", Some(&tok), Some(nudge(5, 5, 101))).await;
        assert_eq!((c, v["code"].as_str()), (503, Some("KeeperBusy")));
        let s = lock(&shared);
        assert_eq!(s.api.events["nudge_refused_bell"], 2);
        assert_eq!(s.api.events["nudge_refused_province"], 1);
        assert_eq!(s.api.events["nudge_refused_shape"], 2);
        drop(s);
        r.stop();
    }
}
