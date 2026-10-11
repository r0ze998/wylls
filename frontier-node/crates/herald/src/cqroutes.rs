//! The MC read paths (contract §8.4; unit CQ2-E), mounted by the one
//! `cqroutes::mount()` call in `server.rs`'s `// MC hook` block. Every
//! existing `/h/*` path is untouched; for an M1 season these answer 404.
//!
//! | path | answer | cache |
//! |---|---|---|
//! | `/h/control/{bell}.bin`, `latest.bin` | `PSFCT1` | immutable; latest `max-age=2` |
//! | `/h/overview2/{ring}/{bell}.bin`, `latest.bin` | `PSFOV2` | immutable; latest `max-age=5` |
//! | `/h/sieges/{bell}.json`, `latest.json` | sieges and keep contests | immutable; latest `max-age=2` |
//! | `/h/siege/{P},{Q},{site}/{declared}.json` | one siege | immutable once written at the season end; live `max-age=5` |
//! | `/h/keep/{P},{Q}.json` | a keep's history | `max-age=5` |
//! | `/h/conquest/{day}.json` | the day's events | immutable once written; live `max-age=5` |
//! | `/h/standings/series.bin`, `latest.json`, `players.json` | standings | `max-age=30` / 5 / 30 |
//! | `/h/call/{day}.json` | Herald's Call | immutable |
//! | `/h/season/final.json` | the final map, standings and movement | immutable |
//! | `/h/status/conquest` | the conquest fold's alarms and counters | `no-store` |
//!
//! `/h/me/{wallet}` gains `alerts[]` and `sieges[]` in `views::me_json`.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

use crate::conquest;
use crate::files::gz_path;
use crate::server::{Shared, IMMUTABLE};

/// The MC routes (merged into the herald's router).
pub fn mount() -> Router<Shared> {
    Router::new()
        .route("/h/control/{file}", get(control))
        .route("/h/overview2/{ring}/{file}", get(overview2))
        .route("/h/sieges/{file}", get(sieges))
        .route("/h/siege/{pqs}/{file}", get(siege))
        .route("/h/keep/{file}", get(keep))
        .route("/h/conquest/{file}", get(conquest_day))
        .route("/h/standings/{file}", get(standings))
        .route("/h/call/{file}", get(call))
        .route("/h/season/final.json", get(final_json))
        .route("/h/status/conquest", get(status))
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

fn body(bytes: Vec<u8>, ctype: &str, cache: &str) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, ctype.to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        bytes,
    )
        .into_response()
}

fn accepts_gzip(h: &HeaderMap) -> bool {
    h.get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|e| e.trim().starts_with("gzip")))
}

/// A file of the output directory with its `.gz` sibling (as `server.rs`).
fn file(app: &Shared, rel: &str, ctype: &str, cache: &str, h: &HeaderMap) -> Option<Response> {
    let p = app.out.path(rel)?;
    if !p.is_file() {
        return None;
    }
    let gz = gz_path(&p);
    let (bytes, enc) = if accepts_gzip(h) && gz.is_file() {
        (std::fs::read(&gz).ok()?, Some("gzip"))
    } else {
        (std::fs::read(&p).ok()?, None)
    };
    let mut r = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CACHE_CONTROL, cache)
        .header(header::VARY, "Accept-Encoding");
    if let Some(e) = enc {
        r = r.header(header::CONTENT_ENCODING, e);
    }
    r.body(Body::from(bytes)).ok()
}

fn read_fold(app: &Shared) -> std::sync::RwLockReadGuard<'_, crate::fold::Fold> {
    app.fold.read().unwrap_or_else(|e| e.into_inner())
}

fn numbered(file: &str, ext: &str) -> Option<u32> {
    file.strip_suffix(ext)?.parse().ok()
}

const BIN: &str = "application/octet-stream";
const JSON: &str = "application/json";

async fn control(State(app): State<Shared>, Path(file): Path<String>, h: HeaderMap) -> Response {
    if file == "latest.bin" {
        let last = read_fold(&app).cq.ct_next.and_then(|b| b.checked_sub(1));
        return last
            .and_then(|b| {
                file_of(
                    &app,
                    &format!("h/control/{b}.bin"),
                    BIN,
                    "public, max-age=2",
                    &h,
                )
            })
            .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"));
    }
    match numbered(&file, ".bin") {
        Some(b) => file_of(&app, &format!("h/control/{b}.bin"), BIN, IMMUTABLE, &h)
            .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet")),
        None => err(StatusCode::NOT_FOUND, "NotFound"),
    }
}

fn file_of(app: &Shared, rel: &str, ctype: &str, cache: &str, h: &HeaderMap) -> Option<Response> {
    file(app, rel, ctype, cache, h)
}

async fn overview2(
    State(app): State<Shared>,
    Path((ring, file)): Path<(u16, String)>,
    h: HeaderMap,
) -> Response {
    if file == "latest.bin" {
        let f = read_fold(&app);
        if !f.cq.on {
            return err(StatusCode::NOT_FOUND, "NotConquest");
        }
        return match conquest::overview2_latest(&f, ring) {
            Some(b) => body(b, BIN, "public, max-age=5"),
            None => err(StatusCode::NOT_FOUND, "NoSuchRing"),
        };
    }
    match numbered(&file, ".bin") {
        Some(b) => file_of(
            &app,
            &format!("h/overview2/{ring}/{b}.bin"),
            BIN,
            IMMUTABLE,
            &h,
        )
        .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet")),
        None => err(StatusCode::NOT_FOUND, "NotFound"),
    }
}

async fn sieges(State(app): State<Shared>, Path(file): Path<String>, h: HeaderMap) -> Response {
    if file == "latest.json" {
        let last = read_fold(&app).cq.ct_next.and_then(|b| b.checked_sub(1));
        return last
            .and_then(|b| {
                file_of(
                    &app,
                    &format!("h/sieges/{b}.json"),
                    JSON,
                    "public, max-age=2",
                    &h,
                )
            })
            .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"));
    }
    match numbered(&file, ".json") {
        Some(b) => file_of(&app, &format!("h/sieges/{b}.json"), JSON, IMMUTABLE, &h)
            .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet")),
        None => err(StatusCode::NOT_FOUND, "NotFound"),
    }
}

fn parse_pqs(s: &str) -> Option<(i16, i16, u8)> {
    let mut it = s.split(',');
    let p = it.next()?.parse().ok()?;
    let q = it.next()?.parse().ok()?;
    let site = it.next()?.parse().ok()?;
    it.next().is_none().then_some((p, q, site))
}

async fn siege(
    State(app): State<Shared>,
    Path((pqs, file)): Path<(String, String)>,
    h: HeaderMap,
) -> Response {
    let (Some((p, q, site)), Some(d)) = (parse_pqs(&pqs), numbered(&file, ".json")) else {
        return err(StatusCode::BAD_REQUEST, "BadSiege");
    };
    if let Some(r) = file_of(
        &app,
        &format!("h/siege/{p},{q},{site}/{d}.json"),
        JSON,
        IMMUTABLE,
        &h,
    ) {
        return r;
    }
    let f = read_fold(&app);
    match f
        .cq
        .sieges
        .get(&(p, q, site, d))
        .and_then(|s| s.to_json().ok())
    {
        Some(j) => body(j.into_bytes(), JSON, "public, max-age=5"),
        None => err(StatusCode::NOT_FOUND, "NoSuchSiege"),
    }
}

async fn keep(State(app): State<Shared>, Path(file): Path<String>) -> Response {
    let pq = file.strip_suffix(".json").and_then(|s| {
        let (p, q) = s.split_once(',')?;
        Some((p.parse::<i16>().ok()?, q.parse::<i16>().ok()?))
    });
    let Some(pq) = pq else {
        return err(StatusCode::BAD_REQUEST, "BadProvince");
    };
    let f = read_fold(&app);
    match f.cq.keeps.get(&pq).and_then(|k| k.to_json().ok()) {
        Some(j) => body(j.into_bytes(), JSON, "public, max-age=5"),
        None => err(StatusCode::NOT_FOUND, "NoSuchKeep"),
    }
}

async fn conquest_day(
    State(app): State<Shared>,
    Path(file): Path<String>,
    h: HeaderMap,
) -> Response {
    let Some(d) = numbered(&file, ".json") else {
        return err(StatusCode::NOT_FOUND, "NotFound");
    };
    let (written, on) = {
        let f = read_fold(&app);
        (d < f.cq.day_next, f.cq.on)
    };
    if written {
        if let Some(r) = file_of(&app, &format!("h/conquest/{d}.json"), JSON, IMMUTABLE, &h) {
            return r;
        }
    }
    if !on {
        return err(StatusCode::NOT_FOUND, "NotConquest");
    }
    let f = read_fold(&app);
    match conquest::day_live(&f, d) {
        Some(j) => body(j.into_bytes(), JSON, "public, max-age=5"),
        None => err(StatusCode::NOT_FOUND, "NotYet"),
    }
}

async fn standings(State(app): State<Shared>, Path(file): Path<String>, h: HeaderMap) -> Response {
    let (rel, ctype, cache) = match file.as_str() {
        "series.bin" => ("h/standings/series.bin", BIN, "public, max-age=30"),
        "latest.json" => ("h/standings/latest.json", JSON, "public, max-age=5"),
        "players.json" => ("h/standings/players.json", JSON, "public, max-age=30"),
        _ => return err(StatusCode::NOT_FOUND, "NotFound"),
    };
    file_of(&app, rel, ctype, cache, &h).unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"))
}

async fn call(State(app): State<Shared>, Path(file): Path<String>, h: HeaderMap) -> Response {
    match numbered(&file, ".json") {
        Some(d) => file_of(&app, &format!("h/call/{d}.json"), JSON, IMMUTABLE, &h)
            .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet")),
        None => err(StatusCode::NOT_FOUND, "NotFound"),
    }
}

async fn final_json(State(app): State<Shared>, h: HeaderMap) -> Response {
    file_of(&app, "h/season/final.json", JSON, IMMUTABLE, &h)
        .unwrap_or_else(|| err(StatusCode::NOT_FOUND, "NotYet"))
}

async fn status(State(app): State<Shared>) -> Response {
    let f = read_fold(&app);
    body(
        serde_json::to_vec(&conquest::status_json(&f)).unwrap_or_default(),
        JSON,
        "no-store",
    )
}
