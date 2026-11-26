//! The herald's HTTP origin (contract §8.4): `/h/*` (files and live
//! answers), `WS /h/ws`, `/frontier/*` (the static web client) and `/gw/*`
//! (the relay's public listener behind the same origin).
//!
//! **Caching.** Per-bell files (`province/…/{b}`, `clash/…`, `overview/…/
//! {b}.bin`) are `immutable`; `latest` answers `max-age=2` (province) and
//! `max-age=5` (overview); a bell-region file is `immutable` once final
//! (archived and resolved everywhere), `max-age=5` before; `/h/season` is
//! `max-age=30` with an ETag; `/h/me` is `no-store`; a full `/h/events`
//! page (500) is `immutable`. Precompressed `.gz` siblings are sent to
//! clients that accept gzip (`Vary: Accept-Encoding`). The web client
//! (`/frontier/*`) has no siblings: each file is read, hashed (ETag) and
//! gzipped once per (path, size, mtime, ctime) and kept in memory
//! (herald-load-50, [`web_file`]).
//!
//! **Security headers** (as `permutation-server/src/play/http.rs`) on
//! every answer: `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
//! `X-Content-Type-Options: nosniff`, and a CSP — the web design §12 policy
//! for `/frontier/*`, `default-src 'none'; frame-ancestors 'none'`
//! elsewhere. `/h/*` answers carry `Access-Control-Allow-Origin: *` (public
//! data; the page's loopback `?herald=` override reads them cross-origin).
//!
//! **`/gw/*`** is the relay's public listener (§8.3) on this origin, as
//! `permutation-server/src/play/proxy.rs`: GET/POST/OPTIONS only, a safe
//! path and query, a body ≤ 64 KiB (checked after axum buffered it, up to
//! its 2 MiB default; audit L-11); of the browser's headers only
//! `Content-Type` goes on; `X-Forwarded-For` is set to the browser's
//! address (the peer, or — when the peer is this machine, a reverse proxy
//! in front — the last address in its `X-Forwarded-For`), which the relay
//! trusts only from this loopback peer; only the relay's status, content
//! type and body come back.
//!
//! **Host allow-list and WS Origin** (devnet-readiness B13, 2026-11-18; the
//! pattern of PR #28's ③ MCP server). DNS rebinding: a page whose name was
//! re-pointed at this machine reaches the herald with *its own* name in
//! `Host`, and a same-origin request carries no `Origin`. Every request's
//! `Host` must name an allowed host exactly (case-insensitive, port
//! ignored, as the MCP SDK's host validation); a missing, malformed or other
//! `Host` is `403 HostNotAllowed` before any route runs. The allowed hosts
//! are loopback (`127.0.0.1`, `localhost`, `::1`) plus the herald's
//! `--public-host` names ([`HostPolicy`]); on by default, no opt-out. `WS
//! /h/ws` also checks `Origin` when a client sends one (browsers always
//! do): its host must be allowed too, else `403 OriginNotAllowed`; a client
//! without `Origin` (bots, the viewer load generator) is not a browser
//! page and is let through.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

use crate::files::{gz_path, Out};
use crate::fold::{Diff, Fold};
use crate::records::{record_json, B64};
use crate::views::{self, SeasonStatic};
use crate::ws::{self, WsCfg, WsStats};
use base64::Engine;

/// The Frontier pages' policy (web design §12). security-audit (2026-11-22):
/// plus `object-src 'none'`, `base-uri 'none'` and `form-action 'self'` —
/// the last two do not fall back to `default-src`, so without them injected
/// markup could re-base relative URLs or post a form off-site. The pages
/// have no plugin, no `<base>` and only script-handled forms.
pub const WEB_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
/// Every other answer's policy.
pub const API_CSP: &str = "default-src 'none'; frame-ancestors 'none'";
pub const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Events per `/h/events` page.
pub const EVENTS_PAGE: usize = 500;
/// Open `WS /h/ws` sockets one client address may hold (security-audit
/// 2026-11-22): without it one client could take every socket of
/// `WsCfg::max_sockets` and leave every player without live updates. The
/// address is [`client_ip`]'s (behind the TLS proxy: the one it appended).
/// Players behind one NAT share it, hence a generous number.
pub const WS_PER_CLIENT: usize = 64;
/// Largest `/gw/*` request body.
pub const GW_MAX_BODY: usize = 64 * 1024;
const GW_MAX_ANSWER: u64 = 16 << 20;
const GW_TIMEOUT: Duration = Duration::from_secs(90);
const GW_CONNECT: Duration = Duration::from_secs(5);

/// Everything a request handler reads.
pub struct App {
    pub fold: Arc<RwLock<Fold>>,
    pub out: Out,
    pub web: Option<PathBuf>,
    /// The relay's public listener, `host:port`.
    pub relay: Option<String>,
    pub season: SeasonStatic,
    pub diffs: broadcast::Sender<Arc<Diff>>,
    /// The findex index (for `/h/events`).
    pub index: Option<PathBuf>,
    /// Explicit read-only path to the opt-in typed wide cache.
    pub wide_index: Option<PathBuf>,
    pub events: Mutex<Option<findex::Reader>>,
    pub ws: WsCfg,
    pub ws_stats: Arc<WsStats>,
    /// Opt-in local-play bootstrap provenance (`/h/status.localPlay`);
    /// `None` (and no such key) for every other herald.
    pub local_play: Option<Value>,
    /// The hosts `Host` (and a WS `Origin`) may name (B13).
    pub hosts: HostPolicy,
    /// Nation chat (`crate::chat`; `--chat-dir`), or `None`: every `/h/chat/*` path answers 404 ChatOff.
    pub chat: Option<Arc<crate::chat::Chat>>,
    cache: Mutex<LiveCache>,
    /// Open sockets per client address ([`WS_PER_CLIENT`]).
    ws_clients: Mutex<std::collections::HashMap<IpAddr, usize>>,
}

/// One client's hold on a socket of [`WS_PER_CLIENT`]; given back on drop.
struct WsClientSlot {
    app: Shared,
    ip: IpAddr,
}

impl WsClientSlot {
    fn take(app: &Shared, ip: IpAddr) -> Option<WsClientSlot> {
        let mut m = app.ws_clients.lock().unwrap_or_else(|e| e.into_inner());
        let n = m.entry(ip).or_insert(0);
        if *n >= WS_PER_CLIENT {
            return None;
        }
        *n += 1;
        Some(WsClientSlot {
            app: app.clone(),
            ip,
        })
    }
}

impl Drop for WsClientSlot {
    fn drop(&mut self) {
        let mut m = self
            .app
            .ws_clients
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(n) = m.get_mut(&self.ip) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                m.remove(&self.ip);
            }
        }
    }
}

/// The host names the herald answers to (B13): loopback and the operator's
/// public names, lowercase, without ports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPolicy {
    names: Vec<String>,
}

/// Loopback names, always allowed.
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

impl Default for HostPolicy {
    fn default() -> Self {
        HostPolicy {
            names: LOOPBACK_HOSTS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

impl HostPolicy {
    /// Loopback plus `public` (`--public-host a.example,b.example`): DNS
    /// names (lowercase letters, digits, `-`, `.`; no leading/trailing
    /// dot or dash, ≤ 253 bytes) or IPv4 literals; no ports, no wildcards.
    pub fn with_public(public: &[&str]) -> Result<HostPolicy, String> {
        let mut p = HostPolicy::default();
        for raw in public {
            let h = raw.trim().to_ascii_lowercase();
            let ok = !h.is_empty()
                && h.len() <= 253
                && !h.starts_with(['.', '-'])
                && !h.ends_with(['.', '-'])
                && !h.contains("..")
                && h.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'
                });
            if !ok {
                return Err(format!(
                    "--public-host {raw:?}: a DNS name or IPv4 address, without port or wildcard"
                ));
            }
            if !p.names.contains(&h) {
                p.names.push(h);
            }
        }
        Ok(p)
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// The host of a `Host` value (`name[:port]`, `[v6][:port]`), lowercase;
    /// `None` when it is not one (userinfo, path, spaces, a bad port…).
    pub fn host_of(authority: &str) -> Option<String> {
        let a = authority.trim();
        let (host, port) = match a.strip_prefix('[') {
            Some(r) => {
                let (h, tail) = r.split_once(']')?;
                (h, tail.strip_prefix(':'))
            }
            None => match a.rsplit_once(':') {
                Some((h, p)) if !h.contains(':') => (h, Some(p)),
                Some(_) => return None,
                None => (a, None),
            },
        };
        if let Some(p) = port {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
        }
        if host.is_empty()
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
        {
            return None;
        }
        Some(host.to_ascii_lowercase())
    }

    /// Whether a `Host` header value names an allowed host.
    pub fn allows_host(&self, host_header: Option<&str>) -> bool {
        host_header
            .and_then(Self::host_of)
            .is_some_and(|h| self.names.contains(&h))
    }

    /// Whether an `Origin` (`http(s)://host[:port]`) names an allowed host;
    /// `null` and other schemes never do.
    pub fn allows_origin(&self, origin: &str) -> bool {
        let rest = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"));
        rest.filter(|r| !r.contains(['/', '@', '?', '#']))
            .and_then(Self::host_of)
            .is_some_and(|h| self.names.contains(&h))
    }
}

/// `(fold version, live clock)`: what a cached season answer depends on.
type SeasonKey = (u64, Option<(u64, i64)>);
/// A season answer: body and ETag.
type SeasonAnswer = Arc<(Vec<u8>, String)>;
/// A territory answer (`/h/world/wide/territory`): gzip, JSON and ETag.
#[cfg(feature = "wide-world-experimental")]
type TerritoryAnswer = Arc<(Vec<u8>, Vec<u8>, String)>;

#[derive(Default)]
struct LiveCache {
    season: Option<(SeasonKey, SeasonAnswer)>,
    overview: std::collections::BTreeMap<u16, (u64, Arc<Vec<u8>>)>,
    roster: std::collections::BTreeMap<u16, (u64, Arc<Vec<u8>>)>,
    /// `/h/world/wide/territory` (`wide_territory.rs`): one answer per
    /// territory revision — `(gzip, json, etag)` — shared by every viewer.
    #[cfg(feature = "wide-world-experimental")]
    territory: Option<(u64, TerritoryAnswer)>,
}

impl App {
    pub fn new(
        fold: Arc<RwLock<Fold>>,
        out: Out,
        season: SeasonStatic,
        diffs: broadcast::Sender<Arc<Diff>>,
    ) -> App {
        App {
            fold,
            out,
            web: None,
            relay: None,
            season,
            diffs,
            index: None,
            wide_index: None,
            events: Mutex::new(None),
            ws: WsCfg::default(),
            ws_stats: Arc::new(WsStats::default()),
            local_play: None,
            hosts: HostPolicy::default(),
            chat: None,
            cache: Mutex::new(LiveCache::default()),
            ws_clients: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

pub type Shared = Arc<App>;

/// The router (callers serve it with `into_make_service_with_connect_info`).
pub fn router(app: Shared) -> Router {
    let guard = app.clone();
    Router::new()
        .route("/h/season", get(season))
        .route("/h/status", get(status))
        .route("/h/world", get(world))
        .route("/h/world/ring/{d}", get(world_ring))
        // the recorded wide world (`wide.rs`; feature `wide-world-experimental`, else 503 WideWorldUnavailable)
        .route("/h/world/wide", get(world_wide))
        .route("/h/world/wide/page", get(world_wide_page))
        .route("/h/world/wide/route", get(world_wide_route))
        .route("/h/world/wide/territory", get(world_wide_territory))
        .route(
            "/h/world/wide/territory/player/{citizen}",
            get(world_wide_territory_player),
        )
        .route("/h/overview/{ring}/{file}", get(overview))
        .route("/h/roster/{ring}/latest.bin", get(roster))
        .route("/h/province/{pq}/{bell}", get(province))
        .route("/h/clash/{pq}/{bell}", get(clash))
        .route("/h/bell/{bell}/region/{r}", get(bell_region))
        .route("/h/me/{wallet}", get(me))
        .route("/h/events", get(events))
        // ② the Grants (`grants.rs`; feature `rights-records`, else 503 GrantsUnavailable)
        .route("/h/grants", get(grants))
        .route("/h/wide-index/status", get(wide_index_status))
        .route("/h/wide-index/events", get(wide_index_events))
        .route("/h/ws", get(ws_route))
        // MC hook: the conquest read paths (CONQUEST-CONTRACT §4.5, §8.4)
        .merge(crate::cqroutes::mount())
        // MC hook end
        // nation chat (owner Q-PT-11 (a) / Q-PT-12; off without --chat-dir: 404 ChatOff)
        .merge(crate::chat::mount())
        .route("/", get(|| async { redirect("/frontier/") }))
        .route("/frontier", get(|| async { redirect("/frontier/") }))
        .route("/frontier/", get(web))
        .route("/frontier/{*path}", get(web))
        .route("/gw", any(gw))
        .route("/gw/{*path}", any(gw))
        .fallback(|| async { err(StatusCode::NOT_FOUND, "NotFound") })
        .layer(middleware::from_fn_with_state(guard, host_guard))
        .layer(middleware::from_fn(security_headers))
        .with_state(app)
}

/// B13: `403 HostNotAllowed` unless `Host` (and an absolute-form target's
/// authority) names an allowed host. Runs before every route.
async fn host_guard(State(app): State<Shared>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    let target_ok = req
        .uri()
        .authority()
        .is_none_or(|a| app.hosts.allows_host(Some(a.as_str())));
    if !target_ok || !app.hosts.allows_host(host) {
        return err(StatusCode::FORBIDDEN, "HostNotAllowed");
    }
    next.run(req).await
}

/// Serves `router(app)` on `listener` until the future is dropped.
pub async fn serve(listener: tokio::net::TcpListener, app: Shared) -> std::io::Result<()> {
    axum::serve(
        listener,
        router(app).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
}

async fn security_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    let csp = if path == "/frontier" || path.starts_with("/frontier/") {
        WEB_CSP
    } else {
        API_CSP
    };
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(csp),
    );
    // (nation chat answers are a nation's private messages: never readable cross-origin)
    if path.starts_with("/h/") && !path.starts_with("/h/chat/") {
        h.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
    }
    res
}

fn err(status: StatusCode, code: &str) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        json!({"ok": false, "code": code}).to_string(),
    )
        .into_response()
}

fn redirect(to: &'static str) -> Response {
    (StatusCode::FOUND, [(header::LOCATION, to)]).into_response()
}

fn json_answer(v: &Value, cache: &str) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        serde_json::to_vec(v).unwrap_or_default(),
    )
        .into_response()
}

fn accepts_gzip(h: &HeaderMap) -> bool {
    h.get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().starts_with("gzip")))
}

/// A file of the output directory (or `None` if absent).
fn file_answer(app: &App, rel: &str, ctype: &str, cache: &str, h: &HeaderMap) -> Option<Response> {
    // (files.rs `Out::serve`: the default output as before; compact output decompressed for a client without gzip)
    let (body, gz) = app.out.serve(rel, accepts_gzip(h))?;
    let enc = gz.then_some("gzip");
    let mut r = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CACHE_CONTROL, cache)
        .header(header::VARY, "Accept-Encoding");
    if let Some(e) = enc {
        r = r.header(header::CONTENT_ENCODING, e);
    }
    r.body(Body::from(body)).ok()
}

fn parse_pq(s: &str) -> Option<(i16, i16)> {
    let (p, q) = s.split_once(',')?;
    Some((p.parse().ok()?, q.parse().ok()?))
}

fn read_fold(app: &App) -> std::sync::RwLockReadGuard<'_, Fold> {
    app.fold.read().unwrap_or_else(|e| e.into_inner())
}

async fn season(State(app): State<Shared>, h: HeaderMap) -> Response {
    let entry = {
        let f = read_fold(&app);
        let mut c = app.cache.lock().unwrap_or_else(|e| e.into_inner());
        match &c.season {
            Some((v, e)) if *v == (f.version, f.live) => e.clone(),
            _ => {
                let Some(v) = views::season_json(&f, &app.season) else {
                    return err(StatusCode::SERVICE_UNAVAILABLE, "NoSeasonYet");
                };
                let body = serde_json::to_vec(&v).unwrap_or_default();
                let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&body))[..32]);
                let e = Arc::new((body, etag));
                c.season = Some(((f.version, f.live), e.clone()));
                e
            }
        }
    };
    let (body, etag) = (&entry.0, &entry.1);
    let cache = "public, max-age=30";
    if h.get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag))
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag.clone()),
                (header::CACHE_CONTROL, cache.into()),
            ],
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json".to_string()),
            (header::CACHE_CONTROL, cache.into()),
            (header::ETAG, etag.clone()),
        ],
        body.clone(),
    )
        .into_response()
}

async fn status(State(app): State<Shared>) -> Response {
    let f = read_fold(&app);
    let a = f.st.alarms;
    let mut v = json!({
        "v": 1, "foldedThrough": f.st.folded_through, "events": f.st.events.to_string(),
        "lastSlot": f.st.last_slot, "live": f.live.map(|l| json!([l.0, l.1])),
        "provinces": f.provinces.len(), "rings": f.rings.keys().collect::<Vec<_>>(),
        "alarms": {"rewrites": a.rewrites, "badRecords": a.bad_records, "clashMismatch": a.clash_mismatch,
            "clashUnchecked": a.clash_unchecked, "writeErrors": a.write_errors},
        "ingest": f.ingest.json(),
        "ws": {"open": app.ws_stats.open.load(std::sync::atomic::Ordering::SeqCst),
            "total": app.ws_stats.total.load(std::sync::atomic::Ordering::SeqCst),
            "droppedSlow": app.ws_stats.dropped_slow.load(std::sync::atomic::Ordering::SeqCst)},
    });
    if let Some(lp) = &app.local_play {
        v["localPlay"] = lp.clone();
    }
    // (devnet-end-season) the season's state: Running / Ended / Closed, its end bell, whether orders are over
    let ss = crate::views::season_state(&f);
    if !ss.is_empty() {
        v["season"] = Value::Object(ss.into_iter().map(|(k, x)| (k.to_string(), x)).collect());
    }
    json_answer(&v, "no-store")
}

/// `/h/world` (`world.rs`): the world's extent and identifiers.
async fn world(State(app): State<Shared>) -> Response {
    let f = read_fold(&app);
    match crate::world::world_json(&f) {
        Some(v) => json_answer(&v, "public, max-age=5"),
        None => err(StatusCode::SERVICE_UNAVAILABLE, "NoSeasonYet"),
    }
}

/// `/h/world/ring/{d}` (`world.rs`): the ring's Provinces on chain.
async fn world_ring(State(app): State<Shared>, Path(d): Path<String>) -> Response {
    let Ok(d) = d.parse::<u16>() else {
        return err(StatusCode::BAD_REQUEST, "BadRing");
    };
    let f = read_fold(&app);
    match crate::world::ring_json(&f, d) {
        Some(v) => json_answer(&v, "public, max-age=5"),
        None => err(StatusCode::NOT_FOUND, "NoSuchRing"),
    }
}

/// `/h/world/wide` (`wide.rs`): the recorded wide world's manifest.
#[cfg(feature = "wide-world-experimental")]
async fn world_wide(State(app): State<Shared>) -> Response {
    if app.season.cluster.trim().eq_ignore_ascii_case("fixture") {
        return err(StatusCode::SERVICE_UNAVAILABLE, "FixtureWorldUnavailable");
    }
    let f = read_fold(&app);
    match crate::wide::manifest_json(&f) {
        Ok(v) => json_answer(&v, "public, max-age=5"),
        Err(e) => err(wide_status(e), e.code()),
    }
}

/// `/h/world/wide/page?limit=&after=` (`wide.rs`): one bounded page.
#[cfg(feature = "wide-world-experimental")]
async fn world_wide_page(
    State(app): State<Shared>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if app.season.cluster.trim().eq_ignore_ascii_case("fixture") {
        return err(StatusCode::SERVICE_UNAVAILABLE, "FixtureWorldUnavailable");
    }
    let limit = match q.get("limit").map(|s| s.parse::<usize>()) {
        None => None,
        Some(Ok(n)) => Some(n),
        Some(Err(_)) => return err(StatusCode::BAD_REQUEST, "BadLimit"),
    };
    let after = q.get("after").map(String::as_str).filter(|s| !s.is_empty());
    let f = read_fold(&app);
    match crate::wide::page_json(&f, after, limit) {
        Ok(v) => json_answer(&v, "public, max-age=5"),
        Err(e) => err(wide_status(e), e.code()),
    }
}

#[cfg(feature = "wide-world-experimental")]
fn wide_status(e: crate::wide::WideFault) -> StatusCode {
    StatusCode::from_u16(e.status()).unwrap_or(StatusCode::BAD_REQUEST)
}

/// At most four exact captures, observed together under one Fold read-lock.
#[cfg(feature = "wide-world-experimental")]
async fn world_wide_route(
    State(app): State<Shared>,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    if app.season.cluster.trim().eq_ignore_ascii_case("fixture") {
        return err(StatusCode::SERVICE_UNAVAILABLE, "FixtureWorldUnavailable");
    }
    let [(name, at)] = q.as_slice() else {
        return err(StatusCode::BAD_REQUEST, "BadRoute");
    };
    if name != "at" {
        return err(StatusCode::BAD_REQUEST, "BadRoute");
    }
    let coords = match crate::wide::parse_route(at) {
        Ok(coords) => coords,
        Err(e) => return err(wide_status(e), e.code()),
    };
    let f = read_fold(&app);
    match crate::wide::route_json(&f, &coords) {
        Ok(v) => json_answer(&v, "no-store"),
        Err(e) => err(wide_status(e), e.code()),
    }
}

/// `/h/world/wide/territory` (`wide_territory.rs`, territory-map-2): the
/// captured territory province records' owned tiles, built once per
/// territory revision (gzip and ETag with it); `If-None-Match` → 304.
#[cfg(feature = "wide-world-experimental")]
async fn world_wide_territory(State(app): State<Shared>, h: HeaderMap) -> Response {
    if app.season.cluster.trim().eq_ignore_ascii_case("fixture") {
        return err(StatusCode::SERVICE_UNAVAILABLE, "FixtureWorldUnavailable");
    }
    let entry = {
        let f = read_fold(&app);
        let Some(rev) = f.wide.as_ref().map(|w| w.territory_revision()) else {
            return err(StatusCode::SERVICE_UNAVAILABLE, "NoSeasonYet");
        };
        let mut c = app.cache.lock().unwrap_or_else(|e| e.into_inner());
        match &c.territory {
            Some((r, e)) if *r == rev => e.clone(),
            _ => {
                let v = match crate::wide_territory::territory_json(&f) {
                    Ok(v) => v,
                    Err(e) => return err(wide_status(e), e.code()),
                };
                let body = serde_json::to_vec(&v).unwrap_or_default();
                let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&body))[..32]);
                let e = Arc::new((crate::files::gzip(&body), body, etag));
                c.territory = Some((rev, e.clone()));
                e
            }
        }
    };
    etag_answer(&h, &entry.0, &entry.1, &entry.2)
}

/// `/h/world/wide/territory/player/{citizen}` (`wide_territory.rs`,
/// player-territory-records, owner 2026-11-25 18:50 Q-TM2-1): ONE Citizen's
/// captured territory summary (tiles, upkeep clock, unpaid, next claim
/// price), with the territory route's cache rules (`max-age=5`, ETag, gzip,
/// `If-None-Match` → 304). Built per request: one account lookup.
#[cfg(feature = "wide-world-experimental")]
async fn world_wide_territory_player(
    State(app): State<Shared>,
    Path(citizen): Path<String>,
    h: HeaderMap,
) -> Response {
    if app.season.cluster.trim().eq_ignore_ascii_case("fixture") {
        return err(StatusCode::SERVICE_UNAVAILABLE, "FixtureWorldUnavailable");
    }
    let Ok(citizen) = citizen.parse::<solana_address::Address>() else {
        return err(StatusCode::BAD_REQUEST, "BadCitizen");
    };
    let body = {
        let f = read_fold(&app);
        match crate::wide_territory::player_json(&f, &citizen.to_bytes()) {
            Ok(v) => serde_json::to_vec(&v).unwrap_or_default(),
            Err(e) => return err(wide_status(e), e.code()),
        }
    };
    let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&body))[..32]);
    let gz = if accepts_gzip(&h) {
        crate::files::gzip(&body)
    } else {
        vec![]
    };
    etag_answer(&h, &gz, &body, &etag)
}

/// A shared public JSON answer with its ETag (`max-age=5`): 304 when
/// `If-None-Match` names it, else the gzip body when the client takes gzip.
#[cfg(feature = "wide-world-experimental")]
fn etag_answer(h: &HeaderMap, gz: &[u8], body: &[u8], etag: &str) -> Response {
    let cache = "public, max-age=5";
    if h.get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag))
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag.to_string()),
                (header::CACHE_CONTROL, cache.into()),
            ],
        )
            .into_response();
    }
    let mut r = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, cache)
        .header(header::ETAG, etag)
        .header(header::VARY, "Accept-Encoding");
    let out = if accepts_gzip(h) {
        r = r.header(header::CONTENT_ENCODING, "gzip");
        gz.to_vec()
    } else {
        body.to_vec()
    };
    r.body(Body::from(out))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Internal"))
}

/// `/h/grants?citizen=<base58>` (`grants.rs`): the season's ② Grants from
/// their records; with `citizen`, only the Grants that Citizen is a party
/// to (issuer or grantee) — the page asks with its own Citizen and draws
/// no other (its fog rule). Unfiltered it is public, like the chain.
#[cfg(feature = "rights-records")]
async fn grants(State(app): State<Shared>, Query(q): Query<Vec<(String, String)>>) -> Response {
    let filter = match q.as_slice() {
        [] => None,
        [(k, v)] if k == "citizen" => match v.parse::<solana_address::Address>() {
            Ok(a) => Some(frontier_abi::addr::citizen_tag(&a.to_bytes())),
            Err(_) => return err(StatusCode::BAD_REQUEST, "BadCitizen"),
        },
        _ => return err(StatusCode::BAD_REQUEST, "BadQuery"),
    };
    let f = read_fold(&app);
    json_answer(&crate::grants::grants_json(&f, filter), "no-store")
}

/// Without the feature there are no Grant views (never an empty list dressed as one).
#[cfg(not(feature = "rights-records"))]
async fn grants(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "GrantsUnavailable")
}

/// Without the feature the recorded wide world is explicitly unavailable
/// (never a dense fallback dressed as one).
#[cfg(not(feature = "wide-world-experimental"))]
async fn world_wide(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideWorldUnavailable")
}

#[cfg(not(feature = "wide-world-experimental"))]
async fn world_wide_page(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideWorldUnavailable")
}

#[cfg(not(feature = "wide-world-experimental"))]
async fn world_wide_route(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideWorldUnavailable")
}

#[cfg(not(feature = "wide-world-experimental"))]
async fn world_wide_territory(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideWorldUnavailable")
}

#[cfg(not(feature = "wide-world-experimental"))]
async fn world_wide_territory_player(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideWorldUnavailable")
}

/// `/h/roster/{ring}/latest.bin` (`roster.rs`): one answer per fold
/// version, shared by every viewer.
async fn roster(State(app): State<Shared>, Path(ring): Path<u16>) -> Response {
    let bin = |b: Vec<u8>| {
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CACHE_CONTROL, "public, max-age=30".to_string()),
            ],
            b,
        )
            .into_response()
    };
    let f = read_fold(&app);
    let mut c = app.cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((v, b)) = c.roster.get(&ring) {
        if *v == f.version {
            return bin(b.to_vec());
        }
    }
    match f.roster_latest(ring) {
        Some(b) => {
            c.roster.insert(ring, (f.version, Arc::new(b.clone())));
            bin(b)
        }
        None => err(StatusCode::NOT_FOUND, "NoSuchRing"),
    }
}

async fn overview(
    State(app): State<Shared>,
    Path((ring, file)): Path<(u16, String)>,
    h: HeaderMap,
) -> Response {
    let bin = |b: Vec<u8>, cache: &str| {
        (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                (header::CACHE_CONTROL, cache.to_string()),
            ],
            b,
        )
            .into_response()
    };
    if file == "latest.bin" {
        let f = read_fold(&app);
        let mut c = app.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((v, b)) = c.overview.get(&ring) {
            if *v == f.version {
                return bin(b.to_vec(), "public, max-age=5");
            }
        }
        return match f.overview_latest(ring) {
            Some(b) => {
                c.overview.insert(ring, (f.version, Arc::new(b.clone())));
                bin(b, "public, max-age=5")
            }
            None => err(StatusCode::NOT_FOUND, "NoSuchRing"),
        };
    }
    let Some(b) = file
        .strip_suffix(".bin")
        .and_then(|b| b.parse::<u32>().ok())
    else {
        return err(StatusCode::NOT_FOUND, "NotFound");
    };
    file_answer(
        &app,
        &format!("h/overview/{ring}/{b}.bin"),
        "application/octet-stream",
        IMMUTABLE,
        &h,
    )
    .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"))
}

async fn province(
    State(app): State<Shared>,
    Path((pq, bell)): Path<(String, String)>,
    h: HeaderMap,
) -> Response {
    let Some((p, q)) = parse_pq(&pq) else {
        return err(StatusCode::BAD_REQUEST, "BadProvince");
    };
    if bell == "latest" {
        let f = read_fold(&app);
        return match views::province_latest(&f, p, q) {
            Some(v) => json_answer(&v, "public, max-age=2"),
            None => err(StatusCode::NOT_FOUND, "NoSuchProvince"),
        };
    }
    let Ok(b) = bell.parse::<u32>() else {
        return err(StatusCode::BAD_REQUEST, "BadBell");
    };
    file_answer(
        &app,
        &format!("h/province/{p},{q}/{b}.json"),
        "application/json",
        IMMUTABLE,
        &h,
    )
    .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"))
}

async fn clash(
    State(app): State<Shared>,
    Path((pq, bell)): Path<(String, u32)>,
    h: HeaderMap,
) -> Response {
    let Some((p, q)) = parse_pq(&pq) else {
        return err(StatusCode::BAD_REQUEST, "BadProvince");
    };
    file_answer(
        &app,
        &format!("h/clash/{p},{q}/{bell}.json"),
        "application/json",
        IMMUTABLE,
        &h,
    )
    .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"))
}

async fn bell_region(
    State(app): State<Shared>,
    Path((bell, r)): Path<(u32, u8)>,
    h: HeaderMap,
) -> Response {
    let fin = read_fold(&app).bell_region_final(bell, r);
    file_answer(
        &app,
        &format!("h/bell/{bell}/region/{r}.json"),
        "application/json",
        if fin { IMMUTABLE } else { "public, max-age=5" },
        &h,
    )
    .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"))
}

async fn me(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    h: HeaderMap,
    Path(wallet): Path<String>,
) -> Response {
    let Ok(w) = wallet.parse::<Address>() else {
        return err(StatusCode::BAD_REQUEST, "BadWallet");
    };
    let citizen = {
        let f = read_fold(&app);
        Address::new_from_array(crate::conquest::me_citizen(&f, &w.to_bytes()))
    };
    let quota = match &app.relay {
        Some(r) => relay_quota(r, &citizen, client_ip(peer.ip(), &h)).await,
        None => Value::Null,
    };
    let f = read_fold(&app);
    json_answer(&views::me_json(&f, &w, quota), "no-store")
}

/// The relay's `/f/quota?citizen=` answer (`null` if it does not answer
/// within 2 s). The caller's address goes along as `X-Forwarded-For`, so
/// the relay's per-IP limit applies to it and not to the herald's
/// loopback address (wave-3 review, W3-D).
async fn relay_quota(relay: &str, citizen: &Address, client: IpAddr) -> Value {
    let url = format!("http://{relay}/f/quota?citizen={citizen}");
    let ip = client.to_string();
    let hdrs = [("X-Forwarded-For", ip.as_str())];
    let get = fclient::http::get_with_headers(&url, &hdrs);
    match tokio::time::timeout(Duration::from_secs(2), get).await {
        Ok(Ok(r)) if (200..300).contains(&r.status) => {
            serde_json::from_slice(&r.body).unwrap_or(Value::Null)
        }
        _ => Value::Null,
    }
}

async fn events(
    State(app): State<Shared>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let after: u64 = match q.get("after").map(|s| s.parse()) {
        None => 0,
        Some(Ok(a)) => a,
        Some(Err(_)) => return err(StatusCode::BAD_REQUEST, "BadAfter"),
    };
    let rows = {
        let mut g = app.events.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            if let Some(p) = &app.index {
                *g = findex::Reader::open(p).ok();
            }
        }
        match g.as_ref() {
            Some(r) => r.events_after(after, EVENTS_PAGE),
            None => return err(StatusCode::SERVICE_UNAVAILABLE, "NoIndex"),
        }
    };
    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            eprintln!("herald: events: {e}");
            *app.events.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return err(StatusCode::SERVICE_UNAVAILABLE, "IndexBusy");
        }
    };
    let next = rows.last().map_or(after, |r| r.ev);
    let full = rows.len() == EVENTS_PAGE;
    let ev: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({"seq": r.ev.to_string(), "slot": r.slot, "sig": r.sig, "kind": r.kind, "bell": r.bell,
                "tx": r.seq, "body_b64": B64.encode(&r.body), "decoded": record_json(&r.body)})
        })
        .collect();
    json_answer(
        &json!({"v": 1, "events": ev, "next": next.to_string(), "full": full}),
        if full { IMMUTABLE } else { "public, max-age=2" },
    )
}

async fn ws_route(State(app): State<Shared>, req: Request) -> Response {
    let h = req.headers();
    let upgrade = h
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let conn = h
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim().eq_ignore_ascii_case("upgrade"))
        });
    let version = h
        .get(header::SEC_WEBSOCKET_VERSION)
        .and_then(|v| v.to_str().ok())
        == Some("13");
    let Some(key) = h
        .get(header::SEC_WEBSOCKET_KEY)
        .and_then(|v| v.to_str().ok())
        .map(String::from)
    else {
        return err(StatusCode::BAD_REQUEST, "NotAWebSocket");
    };
    if !(upgrade && conn && version) {
        return err(StatusCode::BAD_REQUEST, "NotAWebSocket");
    }
    // B13: a browser page may open the socket only from an allowed origin
    // (cross-site WebSocket hijacking; the Host check alone lets any page
    // that knows the real name connect).
    if let Some(o) = h.get(header::ORIGIN) {
        if !o.to_str().is_ok_and(|o| app.hosts.allows_origin(o)) {
            return err(StatusCode::FORBIDDEN, "OriginNotAllowed");
        }
    }
    if app.ws_stats.open.load(std::sync::atomic::Ordering::SeqCst) >= app.ws.max_sockets {
        return err(StatusCode::SERVICE_UNAVAILABLE, "TooManySockets");
    }
    // security-audit: at most WS_PER_CLIENT sockets per client address
    // (a server without connect info, as some tests build it, has no address).
    let slot = match req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| client_ip(c.0.ip(), req.headers()))
    {
        Some(ip) => match WsClientSlot::take(&app, ip) {
            Some(s) => Some(s),
            None => return err(StatusCode::TOO_MANY_REQUESTS, "TooManySocketsFromClient"),
        },
        None => None,
    };
    let rx = app.diffs.subscribe();
    let on = hyper::upgrade::on(req);
    let cfg = app.ws;
    let stats = app.ws_stats.clone();
    tokio::spawn(async move {
        let _slot = slot;
        if let Ok(u) = on.await {
            ws::serve(hyper_util::rt::TokioIo::new(u), rx, cfg, stats).await;
        }
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, ws::accept_key(&key))
        .body(Body::empty())
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Upgrade"))
}

// ------------------------------------------------------------------ static

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" | "sha256" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// A name with a content hash (`app.1a2b3c4d.mjs`): long max-age.
fn hashed(name: &str) -> bool {
    name.split('.')
        .any(|s| s.len() >= 8 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// herald-load-50: one web client file as served — its bytes, its ETag (the first 32 hex of its sha256, as before) and
/// its gzip body (the precompressed `.gz` sibling when there is one, else gzipped here once for a compressible type).
struct WebFile {
    len: u64,
    modified: Option<std::time::SystemTime>,
    /// verify-pr170: the inode change time too — a same-size rewrite whose mtime was put back (`touch -r`, `cp -p`, an
    /// archive's extract) still moves it, and no program can set it.
    changed: Option<(i64, i64)>,
    etag: String,
    body: Bytes,
    gz: Option<Bytes>,
}

/// Files larger than this are read per request, as before (the web client's largest is ~0.4 MB).
const WEB_CACHE_FILE_MAX: u64 = 8 << 20;
/// Entries kept; past it the cache starts over (the client has ~400 files).
const WEB_CACHE_ENTRIES: usize = 4096;

/// herald-load-50 (the devnet 50-player load test): every `/frontier/*` request — a 304 revalidation too — used to
/// read the whole file and hash it, and the client went out uncompressed (no `.gz` siblings in the web tree): 353
/// requests and 8.2 MB per page load, 3.1 MB gzipped. Now each file is read, hashed and gzipped ONCE per (path, size,
/// modification time); a request costs one `stat`. A changed file is read again on its next request (same ETag rule).
fn web_file(p: &std::path::Path) -> Option<Arc<WebFile>> {
    static CACHE: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, Arc<WebFile>>>> =
        std::sync::OnceLock::new();
    let meta = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
    let (len, modified, changed) = (meta.len(), meta.modified().ok(), inode_changed(&meta));
    let cache = CACHE.get_or_init(Default::default);
    if let Some(f) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(p) {
        if f.len == len && f.modified == modified && modified.is_some() && f.changed == changed {
            return Some(f.clone());
        }
    }
    let body = std::fs::read(p).ok()?;
    let etag = format!("\"{}\"", &hex::encode(Sha256::digest(&body))[..32]);
    let compressible = !matches!(
        p.extension().and_then(|e| e.to_str()),
        Some("webp" | "png" | "woff2" | "ico" | "gz")
    );
    let gz = match std::fs::read(gz_path(p)) {
        Ok(z) => Some(Bytes::from(z)),
        // (verify-pr170: only a file the cache keeps is gzipped here — an uncached large file is not compressed
        //  again on every request)
        Err(_) if compressible && body.len() >= 512 && len <= WEB_CACHE_FILE_MAX => {
            Some(Bytes::from(crate::files::gzip(&body)))
        }
        Err(_) => None,
    };
    let f = Arc::new(WebFile {
        len: body.len() as u64,
        modified,
        changed,
        etag,
        body: Bytes::from(body),
        gz,
    });
    // (only a file whose size still matches its stat is kept: a file being rewritten is served, not cached)
    if f.len == len && len <= WEB_CACHE_FILE_MAX {
        let mut c = cache.lock().unwrap_or_else(|e| e.into_inner());
        if c.len() >= WEB_CACHE_ENTRIES {
            c.clear();
        }
        c.insert(p.to_path_buf(), f.clone());
    }
    Some(f)
}

#[cfg(unix)]
fn inode_changed(m: &std::fs::Metadata) -> Option<(i64, i64)> {
    use std::os::unix::fs::MetadataExt;
    Some((m.ctime(), m.ctime_nsec()))
}

#[cfg(not(unix))]
fn inode_changed(_: &std::fs::Metadata) -> Option<(i64, i64)> {
    None
}

async fn web(State(app): State<Shared>, uri: Uri, h: HeaderMap) -> Response {
    let Some(root) = &app.web else {
        return err(StatusCode::NOT_FOUND, "NoWebClient");
    };
    let mut rel = uri
        .path()
        .strip_prefix("/frontier/")
        .unwrap_or("")
        .to_string();
    if rel.is_empty() || rel.ends_with('/') {
        rel.push_str("index.html");
    }
    let safe = rel
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/._-@".contains(&b))
        && rel.split('/').all(|s| !s.is_empty() && !s.starts_with('.'));
    if !safe {
        return err(StatusCode::NOT_FOUND, "NotFound");
    }
    let p = root.join(&rel);
    let Some(f) = web_file(&p) else {
        return err(StatusCode::NOT_FOUND, "NotFound");
    };
    let name = rel.rsplit('/').next().unwrap_or(&rel);
    let etag = f.etag.clone();
    let cache = if hashed(name) { IMMUTABLE } else { "no-cache" };
    if h.get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag))
    {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, etag), (header::CACHE_CONTROL, cache.into())],
        )
            .into_response();
    }
    let (body, enc) = match (accepts_gzip(&h), &f.gz) {
        (true, Some(z)) => (z.clone(), Some("gzip")),
        _ => (f.body.clone(), None),
    };
    let mut r = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(name))
        .header(header::CACHE_CONTROL, cache)
        .header(header::ETAG, etag)
        .header(header::VARY, "Accept-Encoding");
    if let Some(e) = enc {
        r = r.header(header::CONTENT_ENCODING, e);
    }
    r.body(Body::from(body))
        .unwrap_or_else(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Body"))
}

// ------------------------------------------------------------------ /gw

/// The browser's address: the peer, or — when the peer is this machine (a
/// reverse proxy or tunnel in front of the herald) — the last address in
/// the `X-Forwarded-For` it set.
///
/// verify-pr166: the last entry over EVERY `X-Forwarded-For` header line
/// (RFC 9110 §5.3: several lines are one comma-joined list, in order). Only
/// the first line was read, so behind a proxy that appends a line of its own
/// (HAProxy's `option forwardfor`) the client's own line chose the address
/// and every per-address limit of the relay was bypassed.
pub fn client_ip(peer: IpAddr, h: &HeaderMap) -> IpAddr {
    let fwd = h
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .and_then(|a| a.trim().parse().ok());
    match fwd {
        Some(ip) if peer.is_loopback() => ip,
        _ => peer,
    }
}

/// Largest x402 payment header the proxy forwards (a packet-sized
/// transaction, base64 inside base64 JSON).
const GW_MAX_PAYMENT: usize = 8_192;

fn base64_text(v: &str) -> bool {
    !v.is_empty()
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=-_".contains(&b))
}

fn plain(v: &str) -> bool {
    v.bytes().all(|b| b == b'\t' || (0x20..0x7f).contains(&b))
}

/// Pause before the one reconnect after a refused connect (the request
/// never left the herald, so a second try cannot double-send it).
const GW_RECONNECT_PAUSE: Duration = Duration::from_millis(200);

/// One relay round trip on a fresh connection (`Connection: close`; the
/// herald keeps no pool, so there is no stale keep-alive to reuse).
///
/// fix-herald-gw-502 (verify-pr181 O-1): the relay (Node's http server)
/// answers some requests before reading their body (a 429 from the
/// per-address limiter, a 404, a 503 from the funds check) and then closes
/// the socket without lingering. A body that arrives after that close, or
/// is still unread at it, makes the kernel send RST, and the herald's read
/// then failed with "Connection reset by peer" although the whole answer was
/// already in its receive buffer: the player saw 502 `RelayUnavailable`
/// instead of the relay's 429. So:
/// - head and body go out in ONE write (two writes let the relay answer
///   between them; 53/200 resets in evidence/fix-herald-gw-502/race.out);
/// - a failed write still reads the answer (the relay may have answered
///   early and reset the rest of the upload);
/// - a reset after a COMPLETE answer (`Content-Length` met, or the last
///   chunk) keeps that answer; a truncated one is still an error;
/// - only a refused connect is tried again, once: nothing was sent. A
///   request that may have reached the relay is never sent twice (curl's
///   rule: retry only when no byte of the request can have been acted on).
async fn gw_exchange(relay: &str, request: &[u8]) -> Result<fclient::http::Response, String> {
    let connect = || async {
        tokio::time::timeout(GW_CONNECT, tokio::net::TcpStream::connect(relay))
            .await
            .map_err(|_| "connect timeout".to_string())
    };
    let mut s = match connect().await? {
        Ok(s) => s,
        Err(first) => {
            tokio::time::sleep(GW_RECONNECT_PAUSE).await;
            connect()
                .await?
                .map_err(|e| format!("{e} (after one reconnect; first: {first})"))?
        }
    };
    let wrote = s.write_all(request).await;
    let mut buf = vec![];
    let read = (&mut s).take(GW_MAX_ANSWER).read_to_end(&mut buf).await;
    match (wrote, read) {
        (Err(we), Ok(_)) if buf.is_empty() => Err(format!("write: {we}")),
        (_, Ok(_)) => fclient::http::parse_response(&buf).map_err(|e| format!("{e:?}")),
        (w, Err(e)) => complete_answer(&buf).ok_or_else(|| match w {
            Err(we) => format!("write: {we}; read: {e}"),
            Ok(()) => e.to_string(),
        }),
    }
}

/// The answer in `buf` when it is whole: a `Content-Length` body that is all
/// there, or a chunked body up to its last chunk. A body that runs to the
/// close (neither header) cannot be told whole after a reset: `None`.
fn complete_answer(buf: &[u8]) -> Option<fclient::http::Response> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&buf[..end]).ok()?.to_ascii_lowercase();
    let framed = head.lines().skip(1).any(|l| {
        l.split_once(':').is_some_and(|(k, v)| {
            let k = k.trim();
            k == "content-length" || (k == "transfer-encoding" && v.trim() == "chunked")
        })
    });
    if !framed {
        return None;
    }
    fclient::http::parse_response(buf).ok()
}

async fn gw(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(relay) = &app.relay else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "NoRelay");
    };
    if !matches!(method, Method::GET | Method::POST | Method::OPTIONS) {
        return err(StatusCode::METHOD_NOT_ALLOWED, "MethodNotAllowed");
    }
    let path = match uri.path().strip_prefix("/gw") {
        Some("") => "/",
        Some(p) if p.starts_with('/') => p,
        _ => return err(StatusCode::NOT_FOUND, "NotAGatewayPath"),
    };
    let query = uri.query().unwrap_or("");
    let safe_path = path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/-_.~%".contains(&b))
        && !path.split('/').any(|s| s == "..");
    if !safe_path || !plain(query) || query.contains(' ') {
        return err(StatusCode::BAD_REQUEST, "BadGatewayPath");
    }
    if body.len() > GW_MAX_BODY {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "BodyTooLarge");
    }
    let body: &[u8] = if method == Method::POST { &body } else { &[] };
    let mut head = format!(
        "{method} {path}{}{query} HTTP/1.1\r\nHost: {relay}\r\nConnection: close\r\nContent-Length: {}\r\n",
        if query.is_empty() { "" } else { "?" },
        body.len()
    );
    if let Some(ct) = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) {
        if plain(ct) && ct.len() <= 256 {
            head.push_str(&format!("Content-Type: {ct}\r\n"));
        }
    }
    // x402 (the relay's paid Join): the payment header, base64 only.
    if let Some(pay) = h.get("x-payment").and_then(|v| v.to_str().ok()) {
        if base64_text(pay) && pay.len() <= GW_MAX_PAYMENT {
            head.push_str(&format!("X-PAYMENT: {pay}\r\n"));
        }
    }
    head.push_str(&format!(
        "X-Forwarded-For: {}\r\n\r\n",
        client_ip(peer.ip(), &h)
    ));
    let mut request = head.into_bytes();
    request.extend_from_slice(body);
    let answer = gw_exchange(relay, &request);
    let r = match tokio::time::timeout(GW_TIMEOUT, answer).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            eprintln!("herald: /gw{path}: {e}");
            return err(StatusCode::BAD_GATEWAY, "RelayUnavailable");
        }
        Err(_) => return err(StatusCode::GATEWAY_TIMEOUT, "RelayTimeout"),
    };
    let status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut b = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(ct) = r.header("content-type") {
        if plain(ct) {
            b = b.header(header::CONTENT_TYPE, ct);
        }
    }
    if let Some(pr) = r.header("x-payment-response") {
        if base64_text(pr) && pr.len() <= GW_MAX_PAYMENT {
            b = b.header("X-PAYMENT-RESPONSE", pr);
        }
    }
    b.body(Body::from(r.body))
        .unwrap_or_else(|_| err(StatusCode::BAD_GATEWAY, "RelayAnswer"))
}

#[cfg(feature = "wide-index-read-experimental")]
async fn wide_index_status(State(app): State<Shared>) -> Response {
    match crate::wide_read::status_json(&app) {
        Ok(v) => json_answer(&v, "no-store"),
        Err((status, code)) => err(status, code),
    }
}
#[cfg(feature = "wide-index-read-experimental")]
async fn wide_index_events(
    State(app): State<Shared>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    match crate::wide_read::events_json(&app, &q) {
        Ok(v) => json_answer(&v, "no-store"),
        Err((status, code)) => err(status, code),
    }
}
#[cfg(not(feature = "wide-index-read-experimental"))]
async fn wide_index_status(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideIndexUnavailable")
}
#[cfg(not(feature = "wide-index-read-experimental"))]
async fn wide_index_events(State(_app): State<Shared>) -> Response {
    err(StatusCode::SERVICE_UNAVAILABLE, "WideIndexUnavailable")
}

#[cfg(test)]
#[path = "wide_route_http_tests.rs"]
mod wide_route_http_tests;

/// herald-load-50: the web client's file cache (read, hashed and gzipped once per path, size and modification time).
#[cfg(test)]
mod web_file_tests {
    use super::web_file;
    use sha2::{Digest, Sha256};
    use std::io::Read;

    #[test]
    fn a_file_is_hashed_and_gzipped_once_and_read_again_when_it_changes() {
        let dir = std::env::temp_dir().join(format!("herald-web-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let js = dir.join("app.mjs");
        let text = "export const x = 1;\n".repeat(200);
        std::fs::write(&js, &text).unwrap();
        let f = web_file(&js).expect("a file");
        let want = format!(
            "\"{}\"",
            &hex::encode(Sha256::digest(text.as_bytes()))[..32]
        );
        assert_eq!(f.etag, want, "the ETag rule is unchanged");
        assert_eq!(&f.body[..], text.as_bytes());
        let mut back = String::new();
        flate2::read::GzDecoder::new(&f.gz.as_ref().expect("gzipped")[..])
            .read_to_string(&mut back)
            .unwrap();
        assert_eq!(back, text, "the gzip body is the file");
        assert!(f.gz.as_ref().unwrap().len() < text.len() / 4);
        let again = web_file(&js).unwrap();
        assert!(std::sync::Arc::ptr_eq(&f, &again), "served from the cache");
        // a new version (other size; then same size, later mtime) is read again
        std::fs::write(&js, "export const y = 2;\n".repeat(300)).unwrap();
        let g = web_file(&js).unwrap();
        assert_ne!(g.etag, f.etag);
        let same_len = "export const z = 3;\n".repeat(300);
        std::fs::write(&js, &same_len).unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options()
            .write(true)
            .open(&js)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let h = web_file(&js).unwrap();
        assert_eq!(&h.body[..], same_len.as_bytes());
        assert_ne!(h.etag, g.etag);
        // verify-pr170: a same-size rewrite with its modification time put back (`touch -r`, `cp -p`) is read again
        let mtime = std::fs::metadata(&js).unwrap().modified().unwrap();
        let back_dated = "export const w = 4;\n".repeat(300);
        std::fs::write(&js, &back_dated).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&js)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        assert_eq!(std::fs::metadata(&js).unwrap().modified().unwrap(), mtime);
        let k = web_file(&js).unwrap();
        assert_eq!(
            &k.body[..],
            back_dated.as_bytes(),
            "not the cached same-size version"
        );
        // already-compressed images and tiny files go as they are; a directory or a missing file is no file
        let img = dir.join("a.webp");
        std::fs::write(&img, vec![7u8; 4096]).unwrap();
        assert!(web_file(&img).unwrap().gz.is_none());
        let tiny = dir.join("t.mjs");
        std::fs::write(&tiny, "export {};").unwrap();
        assert!(web_file(&tiny).unwrap().gz.is_none());
        assert!(web_file(&dir).is_none());
        assert!(web_file(&dir.join("absent.mjs")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// verify-pr166: the client address behind a loopback proxy is the last
/// entry over every `X-Forwarded-For` line, never a client-written one.
#[cfg(test)]
mod client_ip_tests {
    use super::client_ip;
    use axum::http::{HeaderMap, HeaderValue};
    use std::net::IpAddr;

    #[test]
    fn the_proxys_line_wins_over_the_clients() {
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let mut h = HeaderMap::new();
        assert_eq!(client_ip(lo, &h), lo);
        h.append("x-forwarded-for", HeaderValue::from_static("6.6.6.6"));
        h.append(
            "x-forwarded-for",
            HeaderValue::from_static("7.7.7.7, 198.51.100.200"),
        );
        assert_eq!(
            client_ip(lo, &h),
            "198.51.100.200".parse::<IpAddr>().unwrap(),
            "the appended line's last entry"
        );
        let mut one = HeaderMap::new();
        one.insert(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.6, 198.51.100.201"),
        );
        assert_eq!(
            client_ip(lo, &one),
            "198.51.100.201".parse::<IpAddr>().unwrap()
        );
        // a non-loopback peer: its own address, whatever it wrote
        let peer: IpAddr = "203.0.113.5".parse().unwrap();
        assert_eq!(client_ip(peer, &h), peer);
    }
}
