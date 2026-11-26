//! Nation chat (owner Q-PT-11 (a), 2026-11-26: the in-page nation chat is the production shape; Q-PT-12: operators
//! review reports, personal mute, 3 messages per turn and 40 per day per player, no links, 7-day expiry, operators can
//! delete). Off unless the herald is started with `--chat-dir DIR`: without it every `/h/chat/*` path answers
//! `404 ChatOff` and nothing is stored.
//!
//! **Who may write.** A message is signed by the player's WALLET (Ed25519, the Wallet Standard's `signMessage`) over a
//! domain-separated text naming this world (Season id and program), the nation, the turn (bell), a fresh nonce, the
//! wallet and the text ([`post_message`]). The herald checks the signature, that the turn is within one of its own
//! current bell, that the nonce was not used, and that the wallet is NOW a citizen of that nation in the herald's fold:
//! the wallet's Citizen account exists, is joined, names that nation in `faction` and is not expelled ([`member_of`]).
//!
//! **Who may read.** Reading, reporting and the live socket take a READ TOKEN: one wallet signature over a text naming
//! the world, the nation, the wallet and a validity window of at most [`TOKEN_MAX_SECS`] ([`read_message`]); its
//! membership is checked again at every read and before every pushed message. No other nation's members, and nobody
//! without a token, can read a nation's messages. Read paths are POSTs (the token is never in a URL) and carry no
//! `Access-Control-Allow-Origin` (`server::security_headers`).
//!
//! **Rules** (Q-PT-12): [`PER_TURN`] messages per bell and [`PER_DAY`] per bell-day (144 bells, as the citizens' social
//! service `limits.mjs`) per signer; at most [`MAX_CHARS`] characters, no control characters, no links (scheme,
//! `www.`, a domain with a known top-level name, an IPv4 address, with full-width / spaced / "dot" obfuscations folded
//! first: [`link_in`]); messages are dropped [`KEEP_DAYS`] days (wall clock) after they were posted, reports too.
//!
//! **Moderation.** A member reports a message of their own nation ([`REPORT_REASONS`]); the report keeps a copy of the
//! message for the operator. The operator reads the reports and deletes a message (or dismisses a report) with the
//! admin token of `--chat-admin-token-file` (Bearer), and only from this machine (loopback peer, after the TLS proxy's
//! `X-Forwarded-For`). A deleted message is pushed to sockets as `{"op":"deleted"}`.
//!
//! **Data.** A message holds the wallet address, the nation, the turn, the text, the nonce, the signature and the
//! herald's receive time; nothing else about a person (no IP is stored or logged; per-IP buckets live in memory only).
//! Kept in `DIR/messages.json` and `DIR/reports.json` (atomic rewrites). `DIR` is never served.

// (the private helpers below return the refusal answer itself as their error; it is built once per request)
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;
use tokio::sync::broadcast;

use crate::fold::Fold;
use crate::records::B64;
use crate::server::Shared;
use crate::ws;

/// Messages one signer may post per turn (bell).
pub const PER_TURN: usize = 3;
/// Messages one signer may post per bell-day.
pub const PER_DAY: usize = 40;
/// Bells in a day (600-s bells, as `permutation-gateway/citizens/social/limits.mjs` BELLS_PER_DAY).
pub const BELLS_PER_DAY: u32 = 144;
/// Longest message in characters (Unicode scalar values; the social service's talk length).
pub const MAX_CHARS: usize = 280;
/// Longest message in UTF-8 bytes.
pub const MAX_BYTES: usize = 1024;
/// Most lines in one message.
pub const MAX_LINES: usize = 6;
/// Days a message (and a report) is kept, wall clock.
pub const KEEP_DAYS: u64 = 7;
pub const KEEP_MS: u64 = KEEP_DAYS * 86_400_000;
/// Days a report (with its copy of the message) is kept, wall clock. Provisional (Q-NC-6, open for r0ze): as messages.
pub const REPORT_KEEP_DAYS: u64 = KEEP_DAYS;
pub const REPORT_KEEP_MS: u64 = REPORT_KEEP_DAYS * 86_400_000;
/// Whether an expelled citizen (Citizen v2 `expelled_since` ≠ 0) may still read and write its nation's chat.
/// Provisional (Q-NC-3, open for r0ze): no. A refugee (still in the nation) may.
pub const EXPELLED_MAY_CHAT: bool = false;
/// Longest read-token validity.
pub const TOKEN_MAX_SECS: i64 = 12 * 3600;
/// A token may be issued at most this far in the herald's future (clock skew).
pub const TOKEN_SKEW_SECS: i64 = 300;
/// Reports one member may file per bell-day.
pub const REPORTS_PER_DAY: usize = 10;
pub const REPORT_REASONS: [&str; 4] = ["spam", "abuse", "link", "other"];
/// Messages kept per nation at most (a storage guard far above 7 days of a large nation; oldest dropped first).
pub const NATION_CAP: usize = 20_000;
/// Messages one read answers at most (the newest).
pub const READ_MAX: usize = 200;
/// Request body cap of every chat route.
pub const BODY_MAX: usize = 8 * 1024;
/// Open chat sockets at most, and per client address.
pub const MAX_SOCKETS: usize = 4_096;
pub const SOCKETS_PER_CLIENT: usize = 16;
/// Per-IP bucket for chat POSTs before any signature is checked (memory only; loopback exempt).
pub const IP_BURST: f64 = 30.0;
pub const IP_PER_SEC: f64 = 1.0;
const NATIONS: u8 = permutation_rules::frontier::structure::NATIONS as u8;

pub const POST_DOMAIN: &str = "WYLLS nation chat message v1";
pub const READ_DOMAIN: &str = "WYLLS nation chat read v1";
const READ_NOTE: &str = "Only members of this nation can read its chat. This signature lets this browser read and report messages there until the time above. It cannot post, move tokens or act in the game.";

/// The world a chat belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct World {
    pub season: u64,
    pub program: String,
}

/// The exact text a wallet signs to post (`\n` line ends; the text last, as typed).
pub fn post_message(
    w: &World,
    nation: u8,
    turn: u32,
    nonce: &str,
    wallet: &str,
    text: &str,
) -> String {
    format!(
        "{POST_DOMAIN}\nWorld: {}\nProgram: {}\nNation: {nation}\nTurn: {turn}\nNonce: {nonce}\nWallet: {wallet}\nText:\n{text}",
        w.season, w.program
    )
}

/// The exact text a wallet signs for a read token.
pub fn read_message(w: &World, nation: u8, wallet: &str, issued: i64, expires: i64) -> String {
    format!(
        "{READ_DOMAIN}\nWorld: {}\nProgram: {}\nNation: {nation}\nWallet: {wallet}\nIssued: {issued}\nExpires: {expires}\n{READ_NOTE}",
        w.season, w.program
    )
}

// ------------------------------------------------------------------ text rules

/// Why a text is refused, or `None`.
pub fn text_problem(t: &str) -> Option<&'static str> {
    if t.trim().is_empty() {
        return Some("EmptyText");
    }
    if t != t.trim() {
        return Some("UntrimmedText");
    }
    if t.len() > MAX_BYTES || t.chars().count() > MAX_CHARS {
        return Some("TextTooLong");
    }
    if t.lines().count() > MAX_LINES {
        return Some("TooManyLines");
    }
    let bidi = |c: char| matches!(c as u32, 0x202A..=0x202E | 0x2066..=0x2069);
    if t.chars().any(|c| (c.is_control() && c != '\n') || bidi(c)) {
        return Some("ControlCharacter");
    }
    if link_in(t) {
        return Some("LinkNotAllowed");
    }
    None
}

/// Top-level names a "word.tld" is read as a link with (generic ones and the countries most used for short links).
const TLDS: &[&str] = &[
    "com", "net", "org", "io", "gg", "me", "co", "xyz", "app", "dev", "info", "biz", "jp", "ru",
    "cn", "uk", "de", "fr", "tv", "ly", "link", "site", "online", "top", "club", "shop", "live",
    "store", "tech", "pro", "fun", "icu", "vip", "win", "bid", "page", "art", "cc", "ws", "to",
    "sh", "ai", "gl", "us", "eu", "kr", "tw", "hk", "sg", "in", "br", "es", "it", "nl", "pl", "ch",
    "se", "no", "fi", "au", "ca", "mx", "ar", "id", "ph", "vn", "th", "my", "nz", "ie", "be", "at",
    "dk", "cz", "pt", "gr", "tr", "ua", "za", "edu", "gov", "mil", "int", "mobi", "name", "one",
    "world", "space", "website", "click", "email", "cloud", "today", "news", "blog", "game",
    "games", "lol", "su",
];

/// The text as a link reader would see it: full-width ASCII folded, look-alike full stops made `.`, invisible
/// characters dropped, lower case, `(dot)`-style and spaced dots joined.
fn fold_for_links(t: &str) -> String {
    let mut s = String::with_capacity(t.len());
    for c in t.chars() {
        let u = c as u32;
        let c = match u {
            0xFF01..=0xFF5E => char::from_u32(u - 0xFEE0).unwrap_or(c),
            0x3002 | 0xFF61 | 0x2024 | 0xFE52 | 0x2E31 => '.',
            0x200B..=0x200D | 0x2060 | 0xFEFF | 0x00AD | 0x180E => continue,
            0x3000 => ' ',
            _ => c,
        };
        s.extend(c.to_lowercase());
    }
    for (from, to) in [
        ("(dot)", "."),
        ("[dot]", "."),
        ("{dot}", "."),
        ("<dot>", "."),
        ("(.)", "."),
        ("[.]", "."),
        ("{.}", "."),
        (" dot ", "."),
        ("ドット", "."),
        ("(:)", ":"),
        ("[:]", ":"),
        ("(/)", "/"),
        ("[/]", "/"),
        (" . ", "."),
    ] {
        while s.contains(from) {
            s = s.replace(from, to);
        }
    }
    s
}

/// Whether the text carries a link (Q-PT-12 "no links").
pub fn link_in(t: &str) -> bool {
    let s = fold_for_links(t);
    let tight: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    for k in [
        "://",
        "http:",
        "https:",
        "www.",
        "ftp:",
        "mailto:",
        "javascript:",
        "data:text",
    ] {
        if s.contains(k) || tight.contains(k) {
            return true;
        }
    }
    let b = s.as_bytes();
    let label = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';
    for (i, _) in s.match_indices('.') {
        // the label before the dot (ASCII letters, digits, '-')
        let mut a = i;
        while a > 0 && label(b[a - 1]) {
            a -= 1;
        }
        if a == i {
            continue;
        }
        let mut e = i + 1;
        while e < b.len() && b[e].is_ascii_alphanumeric() {
            e += 1;
        }
        let after = &s[i + 1..e];
        if after.is_empty() {
            continue;
        }
        if TLDS.contains(&after) {
            return true;
        }
        // an IPv4 address: four dot-separated numbers
        if b[a..i].iter().all(u8::is_ascii_digit) {
            let tail = &s[a..];
            let quad: Vec<&str> = tail
                .split(|c: char| !(c.is_ascii_digit() || c == '.'))
                .next()
                .unwrap_or("")
                .split('.')
                .collect();
            if quad.len() >= 4 && quad[..4].iter().all(|x| !x.is_empty() && x.len() <= 3) {
                return true;
            }
        }
    }
    false
}

// ------------------------------------------------------------------ membership

/// The nation `wallet` is a current citizen of, or why not: the wallet's own Citizen account in the fold, joined,
/// `faction` < 6, `expelled_since` = 0 (Citizen v2 @320; reserved zero bytes in v1).
pub fn member_of(f: &Fold, wallet: &[u8; 32]) -> Result<u8, &'static str> {
    use frontier_abi::layout::player::citizen as C;
    let addr = f.ctx.citizen(wallet);
    let Some(c) = f.account(&addr) else {
        return Err("NotACitizen");
    };
    let d = &c.data;
    if d.len() < 328 || d.get(C::WALLET..C::WALLET + 32) != Some(&wallet[..]) {
        return Err("NotACitizen");
    }
    if d[C::FLAGS] & C::FLAG_JOINED == 0 {
        return Err("NotJoined");
    }
    let n = d[C::FACTION];
    if n >= NATIONS {
        return Err("NoNation");
    }
    let expelled = i64::from_le_bytes(d[320..328].try_into().unwrap_or([0; 8]));
    if expelled != 0 && !EXPELLED_MAY_CHAT {
        return Err("Expelled");
    }
    Ok(n)
}

/// The herald's current bell (chain time of the last observed slot), or `None` before the Season is known.
pub fn current_bell(f: &Fold) -> Option<u32> {
    let se = f.season.as_ref()?;
    let now = f.live.map_or(f.st.last_time, |l| l.1);
    fclient::clock::bell_at(se.genesis_ts, now)
}

fn world_of(f: &Fold) -> World {
    World {
        season: f.cfg.season_id,
        program: f.cfg.program.to_string(),
    }
}

// ------------------------------------------------------------------ the store

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Msg {
    pub id: u64,
    pub nation: u8,
    pub wallet: [u8; 32],
    pub turn: u32,
    /// The herald's own bell when it took the message: the limits count by it, not by the signed `turn` (which may be
    /// one either side of it), so the ±1 window cannot widen [`PER_TURN`] (verify-pr263).
    pub bell: u32,
    pub nonce: String,
    pub text: String,
    pub sig: [u8; 64],
    pub at_ms: u64,
}

impl Msg {
    pub fn json(&self) -> Value {
        json!({
            "id": self.id.to_string(), "nation": self.nation,
            "wallet": Address::new_from_array(self.wallet).to_string(),
            "turn": self.turn, "bell": self.bell, "nonce": self.nonce, "text": self.text,
            "signature": B64.encode(self.sig), "at": self.at_ms,
        })
    }
    fn from_json(v: &Value) -> Option<Msg> {
        let sig: [u8; 64] = B64.decode(v["signature"].as_str()?).ok()?.try_into().ok()?;
        let turn = u32::try_from(v["turn"].as_u64()?).ok()?;
        Some(Msg {
            id: v["id"].as_str()?.parse().ok()?,
            nation: u8::try_from(v["nation"].as_u64()?).ok()?,
            wallet: v["wallet"].as_str()?.parse::<Address>().ok()?.to_bytes(),
            turn,
            // (a message stored before the field: its signed turn)
            bell: v["bell"]
                .as_u64()
                .and_then(|b| u32::try_from(b).ok())
                .unwrap_or(turn),
            nonce: v["nonce"].as_str()?.to_string(),
            text: v["text"].as_str()?.to_string(),
            sig,
            at_ms: v["at"].as_u64()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub id: u64,
    pub msg: Msg,
    pub reporter: [u8; 32],
    pub reason: String,
    pub at_ms: u64,
    pub turn: u32,
    /// `open`, `deleted` (the operator deleted the message) or `dismissed`.
    pub state: String,
}

impl Report {
    pub fn json(&self) -> Value {
        json!({
            "id": self.id.to_string(), "message": self.msg.json(),
            "reporter": Address::new_from_array(self.reporter).to_string(),
            "reason": self.reason, "at": self.at_ms, "turn": self.turn, "state": self.state,
        })
    }
    fn from_json(v: &Value) -> Option<Report> {
        Some(Report {
            id: v["id"].as_str()?.parse().ok()?,
            msg: Msg::from_json(&v["message"])?,
            reporter: v["reporter"].as_str()?.parse::<Address>().ok()?.to_bytes(),
            reason: v["reason"].as_str()?.to_string(),
            at_ms: v["at"].as_u64()?,
            turn: u32::try_from(v["turn"].as_u64()?).ok()?,
            state: v["state"].as_str()?.to_string(),
        })
    }
}

/// What a socket is told.
#[derive(Clone, Debug)]
pub enum Event {
    Msg(Msg),
    Deleted { nation: u8, id: u64 },
}

#[derive(Default)]
struct Store {
    next_id: u64,
    next_report: u64,
    nations: Vec<VecDeque<Msg>>,
    reports: Vec<Report>,
    /// (wallet, nonce) → turn, for replay refusal within the turn window (pruned).
    nonces: HashMap<([u8; 32], String), u32>,
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The chat service: one per herald.
pub struct Chat {
    dir: PathBuf,
    admin_token: Option<String>,
    store: Mutex<Store>,
    events: broadcast::Sender<Event>,
    clock: Clock,
    ip: Mutex<HashMap<IpAddr, (f64, u64)>>,
    sockets: AtomicUsize,
    per_client: Mutex<HashMap<IpAddr, usize>>,
}

/// The wall clock in unix milliseconds.
pub fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

impl Chat {
    /// Opens (or starts) the store in `dir`. `admin_token`: the operator's token (≥ 32 characters), or none (the admin
    /// paths then answer 403 AdminOff).
    pub fn open(dir: PathBuf, admin_token: Option<String>) -> Result<Chat, String> {
        Chat::open_with_clock(dir, admin_token, Arc::new(wall_ms))
    }

    pub fn open_with_clock(
        dir: PathBuf,
        admin_token: Option<String>,
        clock: Clock,
    ) -> Result<Chat, String> {
        if let Some(t) = &admin_token {
            if t.len() < 32 || !t.bytes().all(|b| b.is_ascii_graphic()) {
                return Err(
                    "--chat-admin-token-file: the token must be ≥ 32 printable characters".into(),
                );
            }
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut st = Store {
            nations: (0..NATIONS).map(|_| VecDeque::new()).collect(),
            ..Default::default()
        };
        let read = |name: &str| -> Result<Option<Value>, String> {
            match std::fs::read(dir.join(name)) {
                Ok(b) => serde_json::from_slice(&b)
                    .map(Some)
                    .map_err(|e| format!("{name}: {e}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("{name}: {e}")),
            }
        };
        if let Some(v) = read("messages.json")? {
            st.next_id = v["nextId"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            for m in v["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Msg::from_json)
            {
                if m.nation < NATIONS {
                    st.next_id = st.next_id.max(m.id + 1);
                    // (a restart keeps refusing replays of what is stored; pruned at the next post as usual)
                    st.nonces.insert((m.wallet, m.nonce.clone()), m.turn);
                    st.nations[m.nation as usize].push_back(m);
                }
            }
            for q in st.nations.iter_mut() {
                q.make_contiguous().sort_by_key(|m| m.id);
            }
        }
        if let Some(v) = read("reports.json")? {
            st.next_report = v["nextId"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            st.reports = v["reports"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Report::from_json)
                .collect();
            st.next_report = st
                .reports
                .iter()
                .map(|r| r.id + 1)
                .fold(st.next_report, u64::max);
        }
        let (events, _) = broadcast::channel(1_024);
        let chat = Chat {
            dir,
            admin_token,
            store: Mutex::new(st),
            events,
            clock,
            ip: Mutex::new(HashMap::new()),
            sockets: AtomicUsize::new(0),
            per_client: Mutex::new(HashMap::new()),
        };
        chat.prune_and_save();
        Ok(chat)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, st: &Store) {
        let msgs: Vec<Value> = st.nations.iter().flatten().map(Msg::json).collect();
        let m = json!({"v": 1, "nextId": st.next_id.to_string(), "messages": msgs});
        let r = json!({"v": 1, "nextId": st.next_report.to_string(),
            "reports": st.reports.iter().map(Report::json).collect::<Vec<_>>()});
        for (name, v) in [("messages.json", m), ("reports.json", r)] {
            if let Err(e) = write_atomic(&self.dir.join(name), v.to_string().as_bytes()) {
                eprintln!("frontier-herald: chat store {name}: {e}");
            }
        }
    }

    /// Drops what is older than [`KEEP_DAYS`]; saves when something went. → messages dropped.
    pub fn prune_and_save(&self) -> usize {
        let now = (self.clock)();
        let mut st = self.lock();
        let n = prune(&mut st, now);
        if n > 0 {
            self.save(&st);
        }
        n
    }

    /// Takes one token from `ip`'s POST bucket (loopback never limited).
    fn ip_allows(&self, ip: IpAddr) -> bool {
        if ip.is_loopback() {
            return true;
        }
        let now = (self.clock)();
        let mut m = self.ip.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 50_000 {
            m.retain(|_, (_, t)| now.saturating_sub(*t) < 60_000);
        }
        let (tokens, t) = m.entry(ip).or_insert((IP_BURST, now));
        *tokens = (*tokens + now.saturating_sub(*t) as f64 / 1000.0 * IP_PER_SEC).min(IP_BURST);
        *t = now;
        if *tokens < 1.0 {
            return false;
        }
        *tokens -= 1.0;
        true
    }

    /// The live events (tests and sockets).
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Messages counted for `wallet` in the herald's `bell` and its day (by the bell each was taken in, [`Msg::bell`]).
    fn used(st: &Store, wallet: &[u8; 32], bell: u32) -> (usize, usize) {
        let day = bell / BELLS_PER_DAY;
        let mut t = 0;
        let mut d = 0;
        for m in st.nations.iter().flatten().filter(|m| &m.wallet == wallet) {
            if m.bell / BELLS_PER_DAY == day {
                d += 1;
                if m.bell == bell {
                    t += 1;
                }
            }
        }
        (t, d)
    }
}

fn prune(st: &mut Store, now: u64) -> usize {
    let mut n = 0;
    for q in st.nations.iter_mut() {
        while q
            .front()
            .is_some_and(|m| now.saturating_sub(m.at_ms) >= KEEP_MS)
        {
            q.pop_front();
            n += 1;
        }
    }
    let before = st.reports.len();
    st.reports
        .retain(|r| now.saturating_sub(r.at_ms) < REPORT_KEEP_MS);
    n + before - st.reports.len()
}

// ------------------------------------------------------------------ answers

fn answer(status: StatusCode, v: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        v.to_string(),
    )
        .into_response()
}

fn refuse(status: StatusCode, code: &str) -> Response {
    answer(status, json!({"ok": false, "code": code}))
}

fn chat_of(app: &Shared) -> Result<&Arc<Chat>, Response> {
    app.chat
        .as_ref()
        .ok_or_else(|| refuse(StatusCode::NOT_FOUND, "ChatOff"))
}

fn peer_ip(req_ext: Option<&ConnectInfo<SocketAddr>>, h: &HeaderMap) -> IpAddr {
    match req_ext {
        Some(c) => crate::server::client_ip(c.0.ip(), h),
        None => IpAddr::from([127, 0, 0, 1]),
    }
}

/// A browser's POST must come from an allowed origin (as `WS /h/ws`); a client without `Origin` is not a page.
fn origin_ok(app: &Shared, h: &HeaderMap) -> bool {
    match h.get(header::ORIGIN) {
        None => true,
        Some(o) => o.to_str().is_ok_and(|o| app.hosts.allows_origin(o)),
    }
}

fn parse_body(b: &Bytes) -> Result<Value, Response> {
    serde_json::from_slice::<Value>(b)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| refuse(StatusCode::BAD_REQUEST, "BadJson"))
}

fn wallet_of(v: &Value) -> Result<(String, [u8; 32]), &'static str> {
    let s = v.as_str().ok_or("BadWallet")?;
    let a = s.parse::<Address>().map_err(|_| "BadWallet")?;
    if a.to_string() != s {
        return Err("BadWallet");
    }
    Ok((s.to_string(), a.to_bytes()))
}

fn sig_of(v: &Value) -> Result<[u8; 64], &'static str> {
    B64.decode(v.as_str().ok_or("BadSignature")?)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("BadSignature")
}

fn nation_of(v: &Value) -> Result<u8, &'static str> {
    v.as_u64()
        .and_then(|n| u8::try_from(n).ok())
        .filter(|n| *n < NATIONS)
        .ok_or("BadNation")
}

fn verify(wallet: &[u8; 32], msg: &str, sig: &[u8; 64]) -> bool {
    fclient::ports::Signature::from(*sig).verify(wallet, msg.as_bytes())
}

/// A checked read token: the reader's wallet and nation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reader {
    pub wallet: [u8; 32],
    pub nation: u8,
    pub expires: i64,
}

/// Checks a read token `{wallet, nation, issued, expires, signature}` against the world and the wall clock `now_s`;
/// membership is checked by the caller against the fold.
pub fn check_token(w: &World, t: &Value, now_s: i64) -> Result<Reader, &'static str> {
    let (ws, wallet) = wallet_of(&t["wallet"])?;
    let nation = nation_of(&t["nation"])?;
    let issued = t["issued"].as_i64().ok_or("BadToken")?;
    let expires = t["expires"].as_i64().ok_or("BadToken")?;
    let sig = sig_of(&t["signature"])?;
    // (checked arithmetic: a signed window like i64::MIN..i64::MAX must not wrap into a short one — verify-pr263)
    let span = expires.checked_sub(issued).unwrap_or(i64::MAX);
    if expires <= issued || span > TOKEN_MAX_SECS || issued > now_s.saturating_add(TOKEN_SKEW_SECS)
    {
        return Err("BadTokenWindow");
    }
    if expires <= now_s {
        return Err("TokenExpired");
    }
    if !verify(
        &wallet,
        &read_message(w, nation, &ws, issued, expires),
        &sig,
    ) {
        return Err("BadSignature");
    }
    Ok(Reader {
        wallet,
        nation,
        expires,
    })
}

/// The token checked and its wallet still a member of its nation now.
fn reader(app: &Shared, chat: &Chat, t: &Value) -> Result<(Reader, Option<u32>), Response> {
    let f = app.fold.read().unwrap_or_else(|e| e.into_inner());
    let now_s = ((chat.clock)() / 1000) as i64;
    let r =
        check_token(&world_of(&f), t, now_s).map_err(|c| refuse(StatusCode::UNAUTHORIZED, c))?;
    match member_of(&f, &r.wallet) {
        Ok(n) if n == r.nation => Ok((r, current_bell(&f))),
        Ok(_) => Err(refuse(StatusCode::FORBIDDEN, "NotThisNation")),
        Err(c) => Err(refuse(StatusCode::FORBIDDEN, c)),
    }
}

// ------------------------------------------------------------------ routes

/// The chat routes (all under `/h/chat/`; bodies ≤ [`BODY_MAX`]).
pub fn mount() -> Router<Shared> {
    Router::new()
        .route("/h/chat/info", get(info))
        .route("/h/chat/post", post(post_route))
        .route("/h/chat/read", post(read_route))
        .route("/h/chat/report", post(report_route))
        .route("/h/chat/ws", get(ws_route))
        .route("/h/chat/admin/reports", get(admin_reports))
        .route("/h/chat/admin/delete", post(admin_delete))
        .route("/h/chat/admin/dismiss", post(admin_dismiss))
        .layer(DefaultBodyLimit::max(BODY_MAX))
}

fn limits_json() -> Value {
    json!({"perTurn": PER_TURN, "perDay": PER_DAY, "bellsPerDay": BELLS_PER_DAY, "maxChars": MAX_CHARS,
        "maxLines": MAX_LINES, "keepDays": KEEP_DAYS, "tokenMaxSecs": TOKEN_MAX_SECS, "links": false,
        "reasons": REPORT_REASONS})
}

async fn info(State(app): State<Shared>) -> Response {
    if let Err(r) = chat_of(&app) {
        return r;
    }
    let f = app.fold.read().unwrap_or_else(|e| e.into_inner());
    let w = world_of(&f);
    answer(
        StatusCode::OK,
        json!({"ok": true, "v": 1, "world": w.season.to_string(), "program": w.program,
            "turn": current_bell(&f), "limits": limits_json(),
            "postDomain": POST_DOMAIN, "readDomain": READ_DOMAIN}),
    )
}

async fn post_route(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    let ip = peer_ip(
        req.extensions().get::<ConnectInfo<SocketAddr>>(),
        req.headers(),
    );
    if !origin_ok(&app, req.headers()) {
        return refuse(StatusCode::FORBIDDEN, "OriginNotAllowed");
    }
    if !chat.ip_allows(ip) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "SlowDown");
    }
    let b = match axum::body::to_bytes(req.into_body(), BODY_MAX).await {
        Ok(b) => b,
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "TooLarge"),
    };
    let v = match parse_body(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match post_checked(&app, &chat, &v) {
        Ok(m) => answer(StatusCode::OK, json!({"ok": true, "message": m.json()})),
        Err((s, c)) => refuse(s, c),
    }
}

type Refusal = (StatusCode, &'static str);

/// Every check of a post, then the store (the one place a message is accepted).
pub fn post_checked(app: &Shared, chat: &Chat, v: &Value) -> Result<Msg, Refusal> {
    let bad = |c| (StatusCode::BAD_REQUEST, c);
    let (ws, wallet) = wallet_of(&v["wallet"]).map_err(bad)?;
    let nation = nation_of(&v["nation"]).map_err(bad)?;
    let turn = v["turn"]
        .as_u64()
        .and_then(|t| u32::try_from(t).ok())
        .ok_or(bad("BadTurn"))?;
    let nonce = v["nonce"].as_str().ok_or(bad("BadNonce"))?;
    if nonce.len() != 32
        || !nonce
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(bad("BadNonce"));
    }
    let text = v["text"].as_str().ok_or(bad("BadText"))?;
    let sig = sig_of(&v["signature"]).map_err(bad)?;
    if let Some(c) = text_problem(text) {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, c));
    }
    let now_bell = {
        let f = app.fold.read().unwrap_or_else(|e| e.into_inner());
        let w = world_of(&f);
        if !verify(
            &wallet,
            &post_message(&w, nation, turn, nonce, &ws, text),
            &sig,
        ) {
            return Err((StatusCode::UNAUTHORIZED, "BadSignature"));
        }
        match member_of(&f, &wallet) {
            Ok(n) if n == nation => {}
            Ok(_) => return Err((StatusCode::FORBIDDEN, "NotThisNation")),
            Err(c) => return Err((StatusCode::FORBIDDEN, c)),
        }
        current_bell(&f).ok_or((StatusCode::SERVICE_UNAVAILABLE, "NoClockYet"))?
    };
    if turn.abs_diff(now_bell) > 1 {
        return Err((StatusCode::CONFLICT, "StaleTurn"));
    }
    let now = (chat.clock)();
    let mut st = chat.lock();
    prune(&mut st, now);
    st.nonces.retain(|_, t| t.saturating_add(2) >= now_bell);
    if st.nonces.contains_key(&(wallet, nonce.to_string())) {
        return Err((StatusCode::CONFLICT, "Replay"));
    }
    // (counted in the herald's own bell: a message signed for the turn before or after counts in this one — verify-pr263)
    let (t, d) = Chat::used(&st, &wallet, now_bell);
    if t >= PER_TURN {
        return Err((StatusCode::TOO_MANY_REQUESTS, "TurnLimit"));
    }
    if d >= PER_DAY {
        return Err((StatusCode::TOO_MANY_REQUESTS, "DayLimit"));
    }
    let m = Msg {
        id: st.next_id,
        nation,
        wallet,
        turn,
        bell: now_bell,
        nonce: nonce.to_string(),
        text: text.to_string(),
        sig,
        at_ms: now,
    };
    st.next_id += 1;
    st.nonces.insert((wallet, nonce.to_string()), turn);
    let q = &mut st.nations[nation as usize];
    q.push_back(m.clone());
    while q.len() > NATION_CAP {
        q.pop_front();
    }
    chat.save(&st);
    drop(st);
    let _ = chat.events.send(Event::Msg(m.clone()));
    Ok(m)
}

async fn read_route(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    let ip = peer_ip(
        req.extensions().get::<ConnectInfo<SocketAddr>>(),
        req.headers(),
    );
    if !origin_ok(&app, req.headers()) {
        return refuse(StatusCode::FORBIDDEN, "OriginNotAllowed");
    }
    if !chat.ip_allows(ip) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "SlowDown");
    }
    let b = match axum::body::to_bytes(req.into_body(), BODY_MAX).await {
        Ok(b) => b,
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "TooLarge"),
    };
    let v = match parse_body(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (r, bell) = match reader(&app, &chat, &v["token"]) {
        Ok(x) => x,
        Err(resp) => return resp,
    };
    let after: Option<u64> = v["after"].as_str().and_then(|s| s.parse().ok());
    let now = (chat.clock)();
    let mut st = chat.lock();
    if prune(&mut st, now) > 0 {
        chat.save(&st);
    }
    let q = &st.nations[r.nation as usize];
    let list: Vec<Value> = q
        .iter()
        .filter(|m| after.is_none_or(|a| m.id > a))
        .rev()
        .take(READ_MAX)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(Msg::json)
        .collect();
    let used = bell.map(|b| Chat::used(&st, &r.wallet, b));
    answer(
        StatusCode::OK,
        json!({"ok": true, "nation": r.nation, "turn": bell, "messages": list,
            "used": used.map(|(t, d)| json!({"turn": t, "day": d})), "limits": limits_json()}),
    )
}

async fn report_route(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    let ip = peer_ip(
        req.extensions().get::<ConnectInfo<SocketAddr>>(),
        req.headers(),
    );
    if !origin_ok(&app, req.headers()) {
        return refuse(StatusCode::FORBIDDEN, "OriginNotAllowed");
    }
    if !chat.ip_allows(ip) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "SlowDown");
    }
    let b = match axum::body::to_bytes(req.into_body(), BODY_MAX).await {
        Ok(b) => b,
        Err(_) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "TooLarge"),
    };
    let v = match parse_body(&b) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (r, bell) = match reader(&app, &chat, &v["token"]) {
        Ok(x) => x,
        Err(resp) => return resp,
    };
    let Some(id) = v["id"].as_str().and_then(|s| s.parse::<u64>().ok()) else {
        return refuse(StatusCode::BAD_REQUEST, "BadId");
    };
    let reason = v["reason"].as_str().unwrap_or("");
    if !REPORT_REASONS.contains(&reason) {
        return refuse(StatusCode::BAD_REQUEST, "BadReason");
    }
    let bell = bell.unwrap_or(0);
    let now = (chat.clock)();
    let mut st = chat.lock();
    prune(&mut st, now);
    let Some(m) = st.nations[r.nation as usize]
        .iter()
        .find(|m| m.id == id)
        .cloned()
    else {
        // (another nation's message is "not found" too: a reader learns nothing of other nations)
        return refuse(StatusCode::NOT_FOUND, "NoSuchMessage");
    };
    if m.wallet == r.wallet {
        return refuse(StatusCode::BAD_REQUEST, "OwnMessage");
    }
    if st
        .reports
        .iter()
        .any(|x| x.msg.id == id && x.reporter == r.wallet)
    {
        return answer(StatusCode::OK, json!({"ok": true, "already": true}));
    }
    let day = bell / BELLS_PER_DAY;
    let today = st
        .reports
        .iter()
        .filter(|x| x.reporter == r.wallet && x.turn / BELLS_PER_DAY == day)
        .count();
    if today >= REPORTS_PER_DAY {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "ReportLimit");
    }
    let rep = Report {
        id: st.next_report,
        msg: m,
        reporter: r.wallet,
        reason: reason.to_string(),
        at_ms: now,
        turn: bell,
        state: "open".into(),
    };
    st.next_report += 1;
    st.reports.push(rep);
    chat.save(&st);
    answer(StatusCode::OK, json!({"ok": true, "already": false}))
}

// ------------------------------------------------------------------ operator

/// Only from this machine (after the TLS proxy's forwarded address) and with the admin token.
fn admin_ok(chat: &Chat, peer: IpAddr, h: &HeaderMap) -> Result<(), Response> {
    let Some(want) = &chat.admin_token else {
        return Err(refuse(StatusCode::FORBIDDEN, "AdminOff"));
    };
    if !peer.is_loopback() {
        return Err(refuse(StatusCode::FORBIDDEN, "AdminLocalOnly"));
    }
    let got = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    // constant time over the expected length
    let (a, b) = (got.as_bytes(), want.as_bytes());
    let mut diff = (a.len() != b.len()) as u8;
    for (i, x) in b.iter().enumerate() {
        diff |= x ^ a.get(i).copied().unwrap_or(0);
    }
    if diff != 0 {
        return Err(refuse(StatusCode::UNAUTHORIZED, "BadAdminToken"));
    }
    Ok(())
}

fn admin_peer(req: &Request) -> IpAddr {
    peer_ip(
        req.extensions().get::<ConnectInfo<SocketAddr>>(),
        req.headers(),
    )
}

async fn admin_reports(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    if let Err(r) = admin_ok(&chat, admin_peer(&req), req.headers()) {
        return r;
    }
    chat.prune_and_save();
    let st = chat.lock();
    let mut list: Vec<&Report> = st.reports.iter().collect();
    list.sort_by_key(|r| (r.state != "open", std::cmp::Reverse(r.id)));
    answer(
        StatusCode::OK,
        json!({"ok": true, "open": st.reports.iter().filter(|r| r.state == "open").count(),
            "reports": list.into_iter().map(Report::json).collect::<Vec<_>>()}),
    )
}

async fn admin_body(chat: &Chat, req: Request) -> Result<Value, Response> {
    admin_ok(chat, admin_peer(&req), req.headers())?;
    let b = axum::body::to_bytes(req.into_body(), BODY_MAX)
        .await
        .map_err(|_| refuse(StatusCode::PAYLOAD_TOO_LARGE, "TooLarge"))?;
    parse_body(&b)
}

async fn admin_delete(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    let v = match admin_body(&chat, req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(id) = v["id"].as_str().and_then(|s| s.parse::<u64>().ok()) else {
        return refuse(StatusCode::BAD_REQUEST, "BadId");
    };
    let mut st = chat.lock();
    let mut gone = None;
    for q in st.nations.iter_mut() {
        if let Some(i) = q.iter().position(|m| m.id == id) {
            gone = q.remove(i).map(|m| m.nation);
            break;
        }
    }
    let Some(nation) = gone else {
        return refuse(StatusCode::NOT_FOUND, "NoSuchMessage");
    };
    for r in st.reports.iter_mut().filter(|r| r.msg.id == id) {
        r.state = "deleted".into();
    }
    chat.save(&st);
    drop(st);
    let _ = chat.events.send(Event::Deleted { nation, id });
    answer(
        StatusCode::OK,
        json!({"ok": true, "deleted": id.to_string()}),
    )
}

async fn admin_dismiss(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    let v = match admin_body(&chat, req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(id) = v["report"].as_str().and_then(|s| s.parse::<u64>().ok()) else {
        return refuse(StatusCode::BAD_REQUEST, "BadId");
    };
    let mut st = chat.lock();
    let Some(r) = st.reports.iter_mut().find(|r| r.id == id) else {
        return refuse(StatusCode::NOT_FOUND, "NoSuchReport");
    };
    if r.state == "open" {
        r.state = "dismissed".into();
    }
    chat.save(&st);
    answer(StatusCode::OK, json!({"ok": true}))
}

// ------------------------------------------------------------------ the live socket

struct SocketSlot {
    chat: Arc<Chat>,
    ip: IpAddr,
}

impl Drop for SocketSlot {
    fn drop(&mut self) {
        self.chat.sockets.fetch_sub(1, Ordering::SeqCst);
        let mut m = self
            .chat
            .per_client
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

/// `WS /h/chat/ws`: the client sends `{"op":"auth","token":{…}}` first (within 10 s); the herald answers
/// `{"op":"ready","nation":n}` and then pushes `{"op":"msg","message":{…}}` and `{"op":"deleted","id":"…"}` of that
/// nation only. Membership and the token's expiry are checked again before each push; when either fails the socket is
/// told `{"op":"error","code":…}` and closed (4401).
async fn ws_route(State(app): State<Shared>, req: Request) -> Response {
    let chat = match chat_of(&app) {
        Ok(c) => c.clone(),
        Err(r) => return r,
    };
    let h = req.headers();
    let upgrade = h
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let version = h
        .get(header::SEC_WEBSOCKET_VERSION)
        .and_then(|v| v.to_str().ok())
        == Some("13");
    let Some(key) = h
        .get(header::SEC_WEBSOCKET_KEY)
        .and_then(|v| v.to_str().ok())
        .map(String::from)
    else {
        return refuse(StatusCode::BAD_REQUEST, "NotAWebSocket");
    };
    if !(upgrade && version) {
        return refuse(StatusCode::BAD_REQUEST, "NotAWebSocket");
    }
    if !origin_ok(&app, h) {
        return refuse(StatusCode::FORBIDDEN, "OriginNotAllowed");
    }
    let ip = peer_ip(req.extensions().get::<ConnectInfo<SocketAddr>>(), h);
    {
        let mut m = chat.per_client.lock().unwrap_or_else(|e| e.into_inner());
        if chat.sockets.load(Ordering::SeqCst) >= MAX_SOCKETS {
            return refuse(StatusCode::SERVICE_UNAVAILABLE, "TooManySockets");
        }
        let n = m.entry(ip).or_insert(0);
        if *n >= SOCKETS_PER_CLIENT && !ip.is_loopback() {
            return refuse(StatusCode::TOO_MANY_REQUESTS, "TooManySocketsFromClient");
        }
        *n += 1;
        chat.sockets.fetch_add(1, Ordering::SeqCst);
    }
    let slot = SocketSlot {
        chat: chat.clone(),
        ip,
    };
    let on = hyper::upgrade::on(req);
    let app2 = app.clone();
    tokio::spawn(async move {
        let _slot = slot;
        if let Ok(u) = on.await {
            serve_socket(hyper_util::rt::TokioIo::new(u), app2, chat).await;
        }
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_ACCEPT, ws::accept_key(&key))
        .body(Body::empty())
        .unwrap_or_else(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR, "Upgrade"))
}

async fn send_json<W: tokio::io::AsyncWrite + Unpin>(wr: &mut W, v: &Value) -> bool {
    use tokio::io::AsyncWriteExt;
    let f = ws::encode_frame(ws::OP_TEXT, v.to_string().as_bytes(), None);
    matches!(
        tokio::time::timeout(Duration::from_secs(10), wr.write_all(&f)).await,
        Ok(Ok(()))
    )
}

async fn close<W: tokio::io::AsyncWrite + Unpin>(wr: &mut W, code: u16) {
    use tokio::io::AsyncWriteExt;
    let f = ws::encode_frame(ws::OP_CLOSE, &code.to_be_bytes(), None);
    let _ = tokio::time::timeout(Duration::from_secs(2), wr.write_all(&f)).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), wr.shutdown()).await;
}

/// Whether `r` may still be told about its nation now.
fn still_reader(app: &Shared, chat: &Chat, r: &Reader) -> Result<(), &'static str> {
    if r.expires <= ((chat.clock)() / 1000) as i64 {
        return Err("TokenExpired");
    }
    let f = app.fold.read().unwrap_or_else(|e| e.into_inner());
    match member_of(&f, &r.wallet) {
        Ok(n) if n == r.nation => Ok(()),
        Ok(_) => Err("NotThisNation"),
        Err(c) => Err(c),
    }
}

async fn serve_socket<S>(io: S, app: Shared, chat: Arc<Chat>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(io);
    // the first message: the token
    let first = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match ws::read_frame(&mut rd, true).await {
                Ok(f) if f.op == ws::OP_TEXT && f.fin => return Some(f.payload),
                Ok(f) if f.op == ws::OP_PING || f.op == ws::OP_PONG => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()
    .flatten();
    let auth = first
        .and_then(|p| serde_json::from_slice::<Value>(&p).ok())
        .filter(|v| v["op"] == "auth");
    let Some(auth) = auth else {
        let _ = send_json(&mut wr, &json!({"op": "error", "code": "AuthFirst"})).await;
        close(&mut wr, 4400).await;
        return;
    };
    let r = {
        let f = app.fold.read().unwrap_or_else(|e| e.into_inner());
        let now_s = ((chat.clock)() / 1000) as i64;
        check_token(&world_of(&f), &auth["token"], now_s)
    };
    let r = match r.and_then(|r| still_reader(&app, &chat, &r).map(|_| r)) {
        Ok(r) => r,
        Err(code) => {
            let _ = send_json(&mut wr, &json!({"op": "error", "code": code})).await;
            close(&mut wr, 4401).await;
            return;
        }
    };
    let mut rx = chat.subscribe();
    if !send_json(&mut wr, &json!({"op": "ready", "nation": r.nation})).await {
        return;
    }
    // reader task: pings answered, close or garbage ends the socket
    let (ctl_tx, mut ctl) = tokio::sync::mpsc::channel::<Option<Vec<u8>>>(8);
    let reader = tokio::spawn(async move {
        loop {
            match ws::read_frame(&mut rd, true).await {
                Ok(f) if f.op == ws::OP_PING => {
                    if ctl_tx.send(Some(f.payload)).await.is_err() {
                        return;
                    }
                }
                Ok(f) if f.op == ws::OP_CLOSE => {
                    let _ = ctl_tx.send(None).await;
                    return;
                }
                Ok(_) => {}
                Err(_) => {
                    let _ = ctl_tx.send(None).await;
                    return;
                }
            }
        }
    });
    let mut hb = tokio::time::interval(Duration::from_secs(15));
    hb.tick().await;
    let code: u16 = loop {
        tokio::select! {
            e = rx.recv() => {
                let out = match e {
                    Ok(Event::Msg(m)) if m.nation == r.nation => json!({"op": "msg", "message": m.json()}),
                    Ok(Event::Deleted { nation, id }) if nation == r.nation => json!({"op": "deleted", "id": id.to_string()}),
                    Ok(_) => continue,
                    // (missed events: the client reads again)
                    Err(broadcast::error::RecvError::Lagged(_)) => json!({"op": "resync"}),
                    Err(broadcast::error::RecvError::Closed) => break 1001,
                };
                if let Err(c) = still_reader(&app, &chat, &r) {
                    let _ = send_json(&mut wr, &json!({"op": "error", "code": c})).await;
                    break 4401;
                }
                if !send_json(&mut wr, &out).await {
                    break 1006;
                }
            }
            c = ctl.recv() => match c {
                Some(Some(p)) => {
                    use tokio::io::AsyncWriteExt;
                    let f = ws::encode_frame(ws::OP_PONG, &p, None);
                    if wr.write_all(&f).await.is_err() { break 1006; }
                }
                _ => break 1000,
            },
            _ = hb.tick() => {
                if let Err(c) = still_reader(&app, &chat, &r) {
                    let _ = send_json(&mut wr, &json!({"op": "error", "code": c})).await;
                    break 4401;
                }
                use tokio::io::AsyncWriteExt;
                let f = ws::encode_frame(ws::OP_PING, b"hb", None);
                if wr.write_all(&f).await.is_err() { break 1006; }
            }
        }
    };
    if code != 1006 {
        close(&mut wr, code).await;
    }
    reader.abort();
}

/// Messages of `nation` kept now (tests).
pub fn kept(chat: &Chat, nation: u8) -> Vec<Msg> {
    chat.lock().nations[nation as usize]
        .iter()
        .cloned()
        .collect()
}

/// Reports kept now (tests).
pub fn reports(chat: &Chat) -> Vec<Report> {
    chat.lock().reports.clone()
}

/// Wallets with a message kept (tests).
pub fn authors(chat: &Chat) -> HashSet<[u8; 32]> {
    chat.lock()
        .nations
        .iter()
        .flatten()
        .map(|m| m.wallet)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_found_in_their_disguises() {
        for t in [
            "go to https://example.com now",
            "example.com",
            "join discord.gg/abc",
            "t.me/somebody",
            "www.something",
            "ｅｘａｍｐｌｅ．ｃｏｍ",
            "example。com",
            "example(dot)com",
            "example [dot] com",
            "example dot com",
            "example . com",
            "h t t p s : / / x",
            "ex\u{200B}ample.c\u{200B}om",
            "see 192.168.0.1",
            "EXAMPLE.COM",
            "mailto:a@b",
            "a@b.io",
            "サイトはexampleドットcomです",
        ] {
            assert!(link_in(t), "{t:?} should be a link");
        }
        for t in [
            "march at bell 120, then hold",
            "3.5 troops? no, 35",
            "lol www",
            "wwwww",
            "ok. Me too",
            "e.g. the keep at (3,4)",
            "東の砦を取ろう。明日の朝に集合",
            "A・B・C の順で行く",
            "gg",
            "Mr.Smith says hi",
            "v1.2 of the plan",
        ] {
            assert!(!link_in(t), "{t:?} should not be a link");
        }
    }

    #[test]
    fn text_rules() {
        assert_eq!(text_problem(""), Some("EmptyText"));
        assert_eq!(text_problem("  "), Some("EmptyText"));
        assert_eq!(text_problem(" hi"), Some("UntrimmedText"));
        assert_eq!(text_problem(&"a".repeat(281)), Some("TextTooLong"));
        assert_eq!(text_problem(&"あ".repeat(280)), None);
        assert_eq!(text_problem(&"あ".repeat(342)), Some("TextTooLong"));
        assert_eq!(text_problem("a\nb\nc\nd\ne\nf\ng"), Some("TooManyLines"));
        assert_eq!(text_problem("a\u{0007}b"), Some("ControlCharacter"));
        assert_eq!(text_problem("a\u{202E}b"), Some("ControlCharacter"));
        assert_eq!(text_problem("see example.com"), Some("LinkNotAllowed"));
        assert_eq!(text_problem("hold the east keep\nthen march"), None);
    }

    #[test]
    fn the_signed_texts_are_fixed() {
        let w = World {
            season: 7,
            program: "Prog111".into(),
        };
        assert_eq!(
            post_message(&w, 2, 120, "00ff", "Wal1", "hi\nthere"),
            "WYLLS nation chat message v1\nWorld: 7\nProgram: Prog111\nNation: 2\nTurn: 120\nNonce: 00ff\nWallet: Wal1\nText:\nhi\nthere"
        );
        assert!(read_message(&w, 2, "Wal1", 10, 20).starts_with(
            "WYLLS nation chat read v1\nWorld: 7\nProgram: Prog111\nNation: 2\nWallet: Wal1\nIssued: 10\nExpires: 20\nOnly members"
        ));
    }
}
