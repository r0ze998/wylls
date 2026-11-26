//! Nation chat (`src/chat.rs`; owner Q-PT-11 (a), Q-PT-12) over real loopback TCP on an ephemeral port, with the
//! citizens' accounts put into the fold and a test wall clock.
//!
//!   N1 off without `--chat-dir`: every chat path 404 ChatOff; on: `/h/chat/info` names the world and the limits,
//!      no `Access-Control-Allow-Origin`
//!   N2 a post: signed by the wallet, a citizen of that nation → stored; a wrong key, another world, a non-citizen,
//!      a citizen not joined, another nation, an expelled citizen, a foreign Origin → refused
//!   N3 nation-only reading: A's token reads A's messages only; a token claiming B by an A member → NotThisNation;
//!      bad signature / expired / too-long tokens refused; no token → refused
//!   N4 limits: 3 per turn, the next turn again; 40 per bell-day; a stale turn; a replayed nonce
//!   N5 links refused (422 LinkNotAllowed), a long text refused
//!   N6 7-day expiry (and reports with it); messages survive a restart before that
//!   N7 report (own message, another nation's id, reasons, once per reporter) → the operator reads, deletes, dismisses;
//!      admin off without a token, wrong token, not from this machine
//!   N8 WS: auth first; A's members get A's messages and deletions only; a member expelled meanwhile is cut off

mod common;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine;
use common::tmp;
use fclient::ports::ChainInfo;
use herald_fold::chat::{self, Chat, World};
use herald_fold::clash::Provisional;
use herald_fold::files::Out;
use herald_fold::fixture;
use herald_fold::fold::{Capture, Fold, FoldCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use serde_json::{json, Value};
use solana_keypair::Keypair;
use solana_signer::Signer;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const BELL0: u32 = 300;
const ADMIN: &str = "test-admin-token-0123456789abcdef0123456789";

fn drand() -> ChainInfo {
    ChainInfo {
        public_key: [0; 96],
        period: 3,
        genesis_time: 1_692_803_367,
        genesis_seed: [0; 32],
        chain_hash: [0; 32],
        scheme: "bls-unchained-g1-rfc9380".into(),
        beacon_id: "test".into(),
    }
}

struct Player {
    kp: Keypair,
}

impl Player {
    fn new(seed: u8) -> Player {
        Player {
            kp: Keypair::new_from_array([seed; 32]),
        }
    }
    fn addr(&self) -> String {
        self.kp.pubkey().to_string()
    }
    fn bytes(&self) -> [u8; 32] {
        self.kp.pubkey().to_bytes()
    }
    fn sign(&self, m: &str) -> String {
        B64.encode(self.kp.sign_message(m.as_bytes()).as_ref())
    }
}

struct W {
    port: u16,
    fold: Arc<RwLock<Fold>>,
    chat: Option<Arc<Chat>>,
    clock: Arc<AtomicU64>,
    world: World,
}

const T0_MS: u64 = 1_900_000_000_000;

fn citizen_bytes(wallet: &[u8; 32], nation: u8, flags: u8, expelled: i64) -> Vec<u8> {
    use frontier_abi::layout::player::citizen as C;
    let mut d = vec![0u8; 384];
    d[..8].copy_from_slice(b"PSF1CITZ");
    d[C::WALLET..C::WALLET + 32].copy_from_slice(wallet);
    d[C::FACTION] = nation;
    d[C::FLAGS] = flags;
    d[320..328].copy_from_slice(&expelled.to_le_bytes());
    d
}

fn set_citizen(f: &mut Fold, p: &Player, nation: u8, flags: u8, expelled: i64) {
    let a = f.ctx.citizen(&p.bytes());
    f.st.accounts.insert(
        a,
        Capture {
            slot: 1,
            tx: 0,
            data: citizen_bytes(&p.bytes(), nation, flags, expelled),
        },
    );
}

fn set_bell(f: &mut Fold, bell: u32) {
    f.live = Some((
        10_000 + bell as u64,
        fixture::GENESIS_TS + bell as i64 * 600 + 7,
    ));
}

async fn world(name: &str, chat_on: bool, admin: Option<&str>) -> W {
    world_in(&tmp(name), chat_on, admin, Arc::new(AtomicU64::new(T0_MS))).await
}

async fn world_in(
    dir: &std::path::Path,
    chat_on: bool,
    admin: Option<&str>,
    clock: Arc<AtomicU64>,
) -> W {
    let mut f = Fold::new(
        FoldCfg {
            program: fixture::program(),
            season_id: fixture::SEASON_ID,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new(dir.join("out")),
    );
    for t in &fixture::mini_season(2) {
        f.apply(t);
    }
    set_bell(&mut f, BELL0);
    let world = World {
        season: fixture::SEASON_ID,
        program: fixture::program().to_string(),
    };
    let fold = Arc::new(RwLock::new(f));
    let (diffs, _) = broadcast::channel(16);
    let mut app = App::new(
        fold.clone(),
        Out::new(dir.join("out")),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: drand(),
            quotas: json!({}),
        },
        diffs,
    );
    let c2 = clock.clone();
    let chat = chat_on.then(|| {
        Arc::new(
            Chat::open_with_clock(
                dir.join("chat"),
                admin.map(String::from),
                Arc::new(move || c2.load(Ordering::SeqCst)),
            )
            .unwrap(),
        )
    });
    app.chat = chat.clone();
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(server::serve(l, Arc::new(app)));
    W {
        port,
        fold,
        chat,
        clock,
        world,
    }
}

/// One request (Connection: close) → (status, head lower-cased, JSON body or Null).
async fn http(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&Value>,
) -> (u16, String, Value) {
    let b = body.map(|v| v.to_string()).unwrap_or_default();
    let mut req =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if body.is_some() {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    req.push_str("\r\n");
    req.push_str(&b);
    let fut = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        s.write_all(req.as_bytes()).await.unwrap();
        let mut got = vec![];
        s.read_to_end(&mut got).await.unwrap();
        got
    };
    let got = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .expect("answer within 10 s");
    let text = String::from_utf8_lossy(&got).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (
        status,
        head.to_ascii_lowercase(),
        serde_json::from_str(body).unwrap_or(Value::Null),
    )
}

fn nonce(i: u64) -> String {
    format!("{:032x}", i + 0xabc0)
}

fn post_body(
    w: &W,
    p: &Player,
    signer: &Player,
    nation: u8,
    turn: u32,
    n: &str,
    text: &str,
) -> Value {
    let m = chat::post_message(&w.world, nation, turn, n, &p.addr(), text);
    json!({"wallet": p.addr(), "nation": nation, "turn": turn, "nonce": n, "text": text, "signature": signer.sign(&m)})
}

async fn post(w: &W, p: &Player, nation: u8, turn: u32, n: &str, text: &str) -> (u16, Value) {
    let b = post_body(w, p, p, nation, turn, n, text);
    let (s, _, v) = http(w.port, "POST", "/h/chat/post", &[], Some(&b)).await;
    (s, v)
}

fn token_for(w: &W, p: &Player, nation: u8, issued: i64, expires: i64) -> Value {
    let m = chat::read_message(&w.world, nation, &p.addr(), issued, expires);
    json!({"wallet": p.addr(), "nation": nation, "issued": issued, "expires": expires, "signature": p.sign(&m)})
}

fn token(w: &W, p: &Player, nation: u8) -> Value {
    let now = (w.clock.load(Ordering::SeqCst) / 1000) as i64;
    token_for(w, p, nation, now - 10, now + 3600)
}

async fn read(w: &W, t: &Value) -> (u16, Value) {
    let (s, _, v) = http(
        w.port,
        "POST",
        "/h/chat/read",
        &[],
        Some(&json!({"token": t})),
    )
    .await;
    (s, v)
}

fn texts(v: &Value) -> Vec<String> {
    v["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap().to_string())
        .collect()
}

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

/// Two members of nation 1 (a1, a2), one of nation 4 (b1), one non-citizen, one not joined, one expelled.
struct Cast {
    a1: Player,
    a2: Player,
    b1: Player,
    stranger: Player,
    unjoined: Player,
    expelled: Player,
}

fn cast(w: &W) -> Cast {
    use frontier_abi::layout::player::citizen as C;
    let c = Cast {
        a1: Player::new(11),
        a2: Player::new(12),
        b1: Player::new(21),
        stranger: Player::new(31),
        unjoined: Player::new(32),
        expelled: Player::new(33),
    };
    let mut f = w.fold.write().unwrap();
    set_citizen(&mut f, &c.a1, 1, C::FLAG_JOINED, 0);
    set_citizen(
        &mut f,
        &c.a2,
        1,
        C::FLAG_JOINED | C::FLAG_FIRST_HOLDING_FINAL,
        0,
    );
    set_citizen(&mut f, &c.b1, 4, C::FLAG_JOINED, 0);
    set_citizen(&mut f, &c.unjoined, 1, 0, 0);
    set_citizen(&mut f, &c.expelled, 1, C::FLAG_JOINED, 1_800_000_500);
    drop(f);
    c
}

#[tokio::test]
async fn n1_off_and_info() {
    let w = world("chat-n1-off", false, None).await;
    for (m, p) in [
        ("GET", "/h/chat/info"),
        ("POST", "/h/chat/post"),
        ("POST", "/h/chat/read"),
        ("POST", "/h/chat/report"),
        ("GET", "/h/chat/admin/reports"),
        ("POST", "/h/chat/admin/delete"),
    ] {
        let (s, _, v) = http(w.port, m, p, &[], (m == "POST").then_some(&json!({}))).await;
        assert_eq!((s, code(&v)), (404, "ChatOff"), "{m} {p}");
    }
    let w = world("chat-n1-on", true, None).await;
    let (s, head, v) = http(w.port, "GET", "/h/chat/info", &[], None).await;
    assert_eq!(s, 200);
    assert_eq!(v["world"], fixture::SEASON_ID.to_string());
    assert_eq!(v["program"], fixture::program().to_string());
    assert_eq!(v["turn"], BELL0);
    assert_eq!(v["limits"]["perTurn"], 3);
    assert_eq!(v["limits"]["perDay"], 40);
    assert_eq!(v["limits"]["keepDays"], 7);
    assert_eq!(v["limits"]["links"], false);
    assert!(
        !head.contains("access-control-allow-origin"),
        "chat answers are not readable cross-origin"
    );
    assert!(head.contains("cache-control: no-store"));
    // the public reads keep theirs
    let (_, head, _) = http(w.port, "GET", "/h/season", &[], None).await;
    assert!(head.contains("access-control-allow-origin: *"));
}

#[tokio::test]
async fn n2_who_may_post() {
    let w = world("chat-n2", true, None).await;
    let c = cast(&w);
    let (s, v) = post(&w, &c.a1, 1, BELL0, &nonce(1), "hold the east keep").await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["message"]["wallet"], c.a1.addr());
    assert_eq!(v["message"]["nation"], 1);
    // signed by another key
    let b = post_body(&w, &c.a1, &c.a2, 1, BELL0, &nonce(2), "forged");
    let (s, _, v) = http(w.port, "POST", "/h/chat/post", &[], Some(&b)).await;
    assert_eq!((s, code(&v)), (401, "BadSignature"));
    // signed for another world
    let other = World {
        season: fixture::SEASON_ID + 1,
        program: w.world.program.clone(),
    };
    let m = chat::post_message(&other, 1, BELL0, &nonce(3), &c.a1.addr(), "elsewhere");
    let b = json!({"wallet": c.a1.addr(), "nation": 1, "turn": BELL0, "nonce": nonce(3), "text": "elsewhere", "signature": c.a1.sign(&m)});
    let (s, _, v) = http(w.port, "POST", "/h/chat/post", &[], Some(&b)).await;
    assert_eq!((s, code(&v)), (401, "BadSignature"));
    // the text signed is the text stored: a changed text does not verify
    let mut b = post_body(&w, &c.a1, &c.a1, 1, BELL0, &nonce(4), "attack at dawn");
    b["text"] = json!("retreat at dawn");
    let (s, _, v) = http(w.port, "POST", "/h/chat/post", &[], Some(&b)).await;
    assert_eq!((s, code(&v)), (401, "BadSignature"));
    for (p, n, want) in [
        (&c.stranger, 1, "NotACitizen"),
        (&c.unjoined, 1, "NotJoined"),
        (&c.expelled, 1, "Expelled"),
        (&c.b1, 1, "NotThisNation"),
        (&c.a1, 4, "NotThisNation"),
    ] {
        let (s, v) = post(&w, p, n, BELL0, &nonce(5), "hello").await;
        assert_eq!((s, code(&v)), (403, want));
    }
    // malformed
    let (s, _, v) = http(
        w.port,
        "POST",
        "/h/chat/post",
        &[],
        Some(&json!({"wallet": "x"})),
    )
    .await;
    assert_eq!((s, code(&v)), (400, "BadWallet"));
    let (s, v) = post(&w, &c.a1, 6, BELL0, &nonce(6), "hello").await;
    assert_eq!((s, code(&v)), (400, "BadNation"));
    let (s, v) = post(&w, &c.a1, 1, BELL0, "XYZ", "hello").await;
    assert_eq!((s, code(&v)), (400, "BadNonce"));
    // a browser page of another site
    let b = post_body(&w, &c.a1, &c.a1, 1, BELL0, &nonce(7), "hi");
    let (s, _, v) = http(
        w.port,
        "POST",
        "/h/chat/post",
        &[("Origin", "https://evil.example")],
        Some(&b),
    )
    .await;
    assert_eq!((s, code(&v)), (403, "OriginNotAllowed"));
    let (s, _, _) = http(
        w.port,
        "POST",
        "/h/chat/post",
        &[("Origin", &format!("http://127.0.0.1:{}", w.port))],
        Some(&b),
    )
    .await;
    assert_eq!(s, 200);
    // an oversized body
    let big = json!({"pad": "x".repeat(9000)});
    let (s, _, _) = http(w.port, "POST", "/h/chat/post", &[], Some(&big)).await;
    assert_eq!(s, 413);
    assert_eq!(chat::kept(w.chat.as_ref().unwrap(), 1).len(), 2);
}

#[tokio::test]
async fn n3_nation_only_reading() {
    let w = world("chat-n3", true, None).await;
    let c = cast(&w);
    assert_eq!(post(&w, &c.a1, 1, BELL0, &nonce(1), "A: hold").await.0, 200);
    assert_eq!(
        post(&w, &c.b1, 4, BELL0, &nonce(2), "B: march").await.0,
        200
    );
    let (s, v) = read(&w, &token(&w, &c.a2, 1)).await;
    assert_eq!(s, 200);
    assert_eq!(texts(&v), ["A: hold"]);
    assert_eq!(v["nation"], 1);
    let (s, v) = read(&w, &token(&w, &c.b1, 4)).await;
    assert_eq!((s, texts(&v)), (200, vec!["B: march".to_string()]));
    // an A member claiming B, B claiming A: refused
    let (s, v) = read(&w, &token(&w, &c.a1, 4)).await;
    assert_eq!((s, code(&v)), (403, "NotThisNation"));
    let (s, v) = read(&w, &token(&w, &c.b1, 1)).await;
    assert_eq!((s, code(&v)), (403, "NotThisNation"));
    for (p, want) in [
        (&c.stranger, "NotACitizen"),
        (&c.unjoined, "NotJoined"),
        (&c.expelled, "Expelled"),
    ] {
        let (s, v) = read(&w, &token(&w, p, 1)).await;
        assert_eq!((s, code(&v)), (403, want));
    }
    // a token signed by someone else for a1
    let mut t = token(&w, &c.a1, 1);
    t["signature"] = token(&w, &c.b1, 1)["signature"].clone();
    let (s, v) = read(&w, &t).await;
    assert_eq!((s, code(&v)), (401, "BadSignature"));
    let now = (T0_MS / 1000) as i64;
    let (s, v) = read(&w, &token_for(&w, &c.a1, 1, now - 7200, now - 1)).await;
    assert_eq!((s, code(&v)), (401, "TokenExpired"));
    let (s, v) = read(&w, &token_for(&w, &c.a1, 1, now, now + 13 * 3600)).await;
    assert_eq!((s, code(&v)), (401, "BadTokenWindow"));
    let (s, v) = read(&w, &token_for(&w, &c.a1, 1, now + 3600, now + 7200)).await;
    assert_eq!((s, code(&v)), (401, "BadTokenWindow"));
    let (s, v) = read(&w, &Value::Null).await;
    assert_eq!((s, code(&v)), (401, "BadWallet"), "no token: not read");
    // `after`: only newer ones
    assert_eq!(
        post(&w, &c.a2, 1, BELL0, &nonce(3), "A: second").await.0,
        200
    );
    let first = read(&w, &token(&w, &c.a1, 1)).await.1["messages"][0]["id"].clone();
    let (_, _, v) = http(
        w.port,
        "POST",
        "/h/chat/read",
        &[],
        Some(&json!({"token": token(&w, &c.a1, 1), "after": first})),
    )
    .await;
    assert_eq!(texts(&v), ["A: second"]);
    // a member who moves nation loses the old nation's reading at once
    {
        use frontier_abi::layout::player::citizen as C;
        let mut f = w.fold.write().unwrap();
        set_citizen(&mut f, &c.a2, 4, C::FLAG_JOINED, 0);
    }
    let (s, v) = read(&w, &token(&w, &c.a2, 1)).await;
    assert_eq!((s, code(&v)), (403, "NotThisNation"));
}

#[tokio::test]
async fn n4_limits_and_replay() {
    let w = world("chat-n4", true, None).await;
    let c = cast(&w);
    for i in 0..3 {
        assert_eq!(
            post(&w, &c.a1, 1, BELL0, &nonce(i), &format!("m{i}"))
                .await
                .0,
            200
        );
    }
    let (s, v) = post(&w, &c.a1, 1, BELL0, &nonce(3), "m3").await;
    assert_eq!((s, code(&v)), (429, "TurnLimit"));
    // another member is not limited by a1
    assert_eq!(post(&w, &c.a2, 1, BELL0, &nonce(4), "a2").await.0, 200);
    // a replayed post (same nonce)
    let (s, v) = post(&w, &c.a2, 1, BELL0, &nonce(4), "a2").await;
    assert_eq!((s, code(&v)), (409, "Replay"));
    // a turn far from now
    let (s, v) = post(&w, &c.a2, 1, BELL0 + 2, &nonce(5), "late").await;
    assert_eq!((s, code(&v)), (409, "StaleTurn"));
    let (s, v) = post(&w, &c.a2, 1, BELL0 - 2, &nonce(5), "old").await;
    assert_eq!((s, code(&v)), (409, "StaleTurn"));
    // the next turn: 3 more; the read says what is used
    let mut n = 3u64;
    let mut sent = 3;
    let mut bell = BELL0;
    // BELL0 = 300 → day 2 runs bells 288..432
    while sent < 40 {
        bell += 1;
        {
            let mut f = w.fold.write().unwrap();
            set_bell(&mut f, bell);
        }
        for _ in 0..3 {
            if sent == 40 {
                break;
            }
            n += 1;
            let (s, v) = post(&w, &c.a1, 1, bell, &nonce(100 + n), "day").await;
            assert_eq!(s, 200, "post {sent}: {v}");
            sent += 1;
        }
    }
    let (_, v) = read(&w, &token(&w, &c.a1, 1)).await;
    assert_eq!(v["used"]["day"], 40);
    bell += 1;
    {
        let mut f = w.fold.write().unwrap();
        set_bell(&mut f, bell);
    }
    let (s, v) = post(&w, &c.a1, 1, bell, &nonce(999), "41st").await;
    assert_eq!((s, code(&v)), (429, "DayLimit"));
    // the next day
    let next_day = (bell / chat::BELLS_PER_DAY + 1) * chat::BELLS_PER_DAY;
    {
        let mut f = w.fold.write().unwrap();
        set_bell(&mut f, next_day);
    }
    assert_eq!(
        post(&w, &c.a1, 1, next_day, &nonce(1000), "new day")
            .await
            .0,
        200
    );
}

#[tokio::test]
async fn n5_links_and_size() {
    let w = world("chat-n5", true, None).await;
    let c = cast(&w);
    for (i, t) in [
        "see https://x.example",
        "discord.gg/abc",
        "example dot com",
        "ｅｘａｍｐｌｅ．ｃｏｍ",
        "h t t p : / / a",
    ]
    .iter()
    .enumerate()
    {
        let (s, v) = post(&w, &c.a1, 1, BELL0, &nonce(i as u64), t).await;
        assert_eq!((s, code(&v)), (422, "LinkNotAllowed"), "{t}");
    }
    let (s, v) = post(&w, &c.a1, 1, BELL0, &nonce(50), &"x".repeat(281)).await;
    assert_eq!((s, code(&v)), (422, "TextTooLong"));
    let (s, v) = post(&w, &c.a1, 1, BELL0, &nonce(51), "").await;
    assert_eq!((s, code(&v)), (422, "EmptyText"));
    // a refused post uses no quota
    for i in 0..3 {
        assert_eq!(
            post(&w, &c.a1, 1, BELL0, &nonce(60 + i), "ok 3.5 e.g. www")
                .await
                .0,
            200
        );
    }
}

#[tokio::test]
async fn n6_seven_day_expiry_and_restart() {
    let dir = tmp("chat-n6");
    let clock = Arc::new(AtomicU64::new(T0_MS));
    let w = world_in(&dir, true, Some(ADMIN), clock.clone()).await;
    let c = cast(&w);
    assert_eq!(post(&w, &c.a1, 1, BELL0, &nonce(1), "old one").await.0, 200);
    let id = read(&w, &token(&w, &c.a2, 1)).await.1["messages"][0]["id"].clone();
    let (s, _, _) = http(
        w.port,
        "POST",
        "/h/chat/report",
        &[],
        Some(&json!({"token": token(&w, &c.a2, 1), "id": id, "reason": "spam"})),
    )
    .await;
    assert_eq!(s, 200);
    clock.store(T0_MS + 6 * 86_400_000, Ordering::SeqCst);
    {
        let mut f = w.fold.write().unwrap();
        set_bell(&mut f, BELL0 + 1);
    }
    assert_eq!(
        post(&w, &c.a1, 1, BELL0 + 1, &nonce(2), "new one").await.0,
        200
    );
    assert_eq!(
        texts(&read(&w, &token(&w, &c.a2, 1)).await.1),
        ["old one", "new one"]
    );
    // a restart keeps them (the store is on disk)
    let w2 = world_in(&dir, true, Some(ADMIN), clock.clone()).await;
    {
        let mut f = w2.fold.write().unwrap();
        set_bell(&mut f, BELL0 + 1);
    }
    let _ = cast(&w2);
    assert_eq!(
        texts(&read(&w2, &token(&w2, &c.a2, 1)).await.1),
        ["old one", "new one"]
    );
    assert_eq!(chat::reports(w2.chat.as_ref().unwrap()).len(), 1);
    // 7 days after the first: it is gone, the second stays; its report is gone too
    clock.store(T0_MS + 7 * 86_400_000, Ordering::SeqCst);
    assert_eq!(
        texts(&read(&w2, &token(&w2, &c.a2, 1)).await.1),
        ["new one"]
    );
    let (_, _, v) = http(
        w2.port,
        "GET",
        "/h/chat/admin/reports",
        &[("Authorization", &format!("Bearer {ADMIN}"))],
        None,
    )
    .await;
    assert_eq!(v["reports"].as_array().unwrap().len(), 0);
    // and gone from disk
    let disk = std::fs::read_to_string(dir.join("chat/messages.json")).unwrap();
    assert!(!disk.contains("old one") && disk.contains("new one"));
    // the periodic prune (no request) drops the rest
    clock.store(T0_MS + 14 * 86_400_000, Ordering::SeqCst);
    assert_eq!(w2.chat.as_ref().unwrap().prune_and_save(), 1);
    assert!(!std::fs::read_to_string(dir.join("chat/messages.json"))
        .unwrap()
        .contains("new one"));
}

#[tokio::test]
async fn n7_report_and_operator() {
    let w = world("chat-n7", true, Some(ADMIN)).await;
    let c = cast(&w);
    assert_eq!(
        post(&w, &c.a1, 1, BELL0, &nonce(1), "rude words").await.0,
        200
    );
    assert_eq!(post(&w, &c.b1, 4, BELL0, &nonce(2), "B only").await.0, 200);
    let a_msgs = read(&w, &token(&w, &c.a2, 1)).await.1;
    let id = a_msgs["messages"][0]["id"].clone();
    let b_id = read(&w, &token(&w, &c.b1, 4)).await.1["messages"][0]["id"].clone();
    let rep = |p: &Player, n: u8, id: &Value, reason: &str| json!({"token": token(&w, p, n), "id": id, "reason": reason});
    let port = w.port;
    let r = |b: Value| async move {
        let (s, _, v) = http(port, "POST", "/h/chat/report", &[], Some(&b)).await;
        (s, v)
    };
    assert_eq!(r(rep(&c.a2, 1, &id, "abuse")).await.0, 200);
    assert_eq!(r(rep(&c.a2, 1, &id, "abuse")).await.1["already"], true);
    let (s, v) = r(rep(&c.a1, 1, &id, "spam")).await;
    assert_eq!((s, code(&v)), (400, "OwnMessage"));
    let (s, v) = r(rep(&c.a2, 1, &b_id, "spam")).await;
    assert_eq!(
        (s, code(&v)),
        (404, "NoSuchMessage"),
        "another nation's message is not found"
    );
    let (s, v) = r(rep(&c.a2, 1, &id, "because")).await;
    assert_eq!((s, code(&v)), (400, "BadReason"));
    let (s, v) = r(rep(&c.stranger, 1, &id, "spam")).await;
    assert_eq!((s, code(&v)), (403, "NotACitizen"));
    // the operator
    let auth = format!("Bearer {ADMIN}");
    let (s, _, v) = http(w.port, "GET", "/h/chat/admin/reports", &[], None).await;
    assert_eq!((s, code(&v)), (401, "BadAdminToken"));
    let (s, _, v) = http(
        w.port,
        "GET",
        "/h/chat/admin/reports",
        &[(
            "Authorization",
            "Bearer wrong-token-wrong-token-wrong-token-xx",
        )],
        None,
    )
    .await;
    assert_eq!((s, code(&v)), (401, "BadAdminToken"));
    // through the TLS proxy (a loopback peer forwarding an outside address): not this machine
    let (s, _, v) = http(
        w.port,
        "GET",
        "/h/chat/admin/reports",
        &[("Authorization", &auth), ("X-Forwarded-For", "203.0.113.9")],
        None,
    )
    .await;
    assert_eq!((s, code(&v)), (403, "AdminLocalOnly"));
    let (s, _, v) = http(
        w.port,
        "GET",
        "/h/chat/admin/reports",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(v["open"], 1);
    let r0 = &v["reports"][0];
    assert_eq!(r0["message"]["text"], "rude words");
    assert_eq!(r0["reporter"], c.a2.addr());
    assert_eq!(r0["reason"], "abuse");
    // delete: gone for readers, the report says so
    let (s, _, _) = http(
        w.port,
        "POST",
        "/h/chat/admin/delete",
        &[("Authorization", &auth)],
        Some(&json!({"id": id})),
    )
    .await;
    assert_eq!(s, 200);
    assert!(texts(&read(&w, &token(&w, &c.a2, 1)).await.1).is_empty());
    let (_, _, v) = http(
        w.port,
        "GET",
        "/h/chat/admin/reports",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!(
        (v["open"].as_u64(), v["reports"][0]["state"].as_str()),
        (Some(0), Some("deleted"))
    );
    let (s, _, v) = http(
        w.port,
        "POST",
        "/h/chat/admin/delete",
        &[("Authorization", &auth)],
        Some(&json!({"id": id})),
    )
    .await;
    assert_eq!((s, code(&v)), (404, "NoSuchMessage"));
    // dismiss
    assert_eq!(
        post(&w, &c.a2, 1, BELL0, &nonce(3), "borderline").await.0,
        200
    );
    let id2 = read(&w, &token(&w, &c.a1, 1)).await.1["messages"][0]["id"].clone();
    assert_eq!(r(rep(&c.a1, 1, &id2, "other")).await.0, 200);
    let rid = chat::reports(w.chat.as_ref().unwrap())
        .iter()
        .find(|x| x.msg.id.to_string() == id2.as_str().unwrap())
        .unwrap()
        .id;
    let (s, _, _) = http(
        w.port,
        "POST",
        "/h/chat/admin/dismiss",
        &[("Authorization", &auth)],
        Some(&json!({"report": rid.to_string()})),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(
        texts(&read(&w, &token(&w, &c.a1, 1)).await.1),
        ["borderline"],
        "a dismissed report keeps the message"
    );
    // no token configured → admin off
    let w2 = world("chat-n7-noadmin", true, None).await;
    let (s, _, v) = http(
        w2.port,
        "GET",
        "/h/chat/admin/reports",
        &[("Authorization", &auth)],
        None,
    )
    .await;
    assert_eq!((s, code(&v)), (403, "AdminOff"));
    // a short token is refused at start
    assert!(Chat::open(tmp("chat-n7-short"), Some("short".into())).is_err());
}

// ------------------------------------------------------------------ WS

async fn ws_open(port: u16) -> herald_fold::ws::Client {
    herald_fold::ws::Client::connect(&format!("127.0.0.1:{port}"), "/h/chat/ws")
        .await
        .unwrap()
}

async fn next(c: &mut herald_fold::ws::Client) -> Option<Value> {
    tokio::time::timeout(Duration::from_secs(5), c.next_text())
        .await
        .ok()
        .flatten()
        .and_then(|t| serde_json::from_str(&t).ok())
}

#[tokio::test]
async fn n8_live_socket() {
    let w = world("chat-n8", true, Some(ADMIN)).await;
    let c = cast(&w);
    // auth first
    let mut x = ws_open(w.port).await;
    x.send_text(&json!({"op": "sub"}).to_string())
        .await
        .unwrap();
    assert_eq!(next(&mut x).await.unwrap()["code"], "AuthFirst");
    // a bad token
    let mut x = ws_open(w.port).await;
    x.send_text(&json!({"op": "auth", "token": token(&w, &c.a1, 4)}).to_string())
        .await
        .unwrap();
    assert_eq!(next(&mut x).await.unwrap()["code"], "NotThisNation");
    // a1 (nation 1) and b1 (nation 4) listen
    let mut a = ws_open(w.port).await;
    a.send_text(&json!({"op": "auth", "token": token(&w, &c.a1, 1)}).to_string())
        .await
        .unwrap();
    assert_eq!(
        next(&mut a).await.unwrap(),
        json!({"op": "ready", "nation": 1})
    );
    let mut b = ws_open(w.port).await;
    b.send_text(&json!({"op": "auth", "token": token(&w, &c.b1, 4)}).to_string())
        .await
        .unwrap();
    assert_eq!(next(&mut b).await.unwrap()["op"], "ready");
    // B posts, then A posts: a1 gets A's only (the first thing it gets is A's)
    assert_eq!(
        post(&w, &c.b1, 4, BELL0, &nonce(1), "B secret").await.0,
        200
    );
    assert_eq!(post(&w, &c.a2, 1, BELL0, &nonce(2), "A plan").await.0, 200);
    let m = next(&mut a).await.unwrap();
    assert_eq!(
        (m["op"].as_str(), m["message"]["text"].as_str()),
        (Some("msg"), Some("A plan"))
    );
    let m = next(&mut b).await.unwrap();
    assert_eq!(m["message"]["text"], "B secret");
    // a deletion of A's message reaches A only
    let id = m["message"]["id"].clone();
    let a_id = read(&w, &token(&w, &c.a1, 1)).await.1["messages"][0]["id"].clone();
    let auth = format!("Bearer {ADMIN}");
    assert_eq!(
        http(
            w.port,
            "POST",
            "/h/chat/admin/delete",
            &[("Authorization", &auth)],
            Some(&json!({"id": a_id}))
        )
        .await
        .0,
        200
    );
    assert_eq!(
        next(&mut a).await.unwrap(),
        json!({"op": "deleted", "id": a_id})
    );
    assert_eq!(
        http(
            w.port,
            "POST",
            "/h/chat/admin/delete",
            &[("Authorization", &auth)],
            Some(&json!({"id": id}))
        )
        .await
        .0,
        200
    );
    assert_eq!(next(&mut b).await.unwrap()["op"], "deleted");
    // a1 is expelled: the next nation-1 message is not given to it; it is told why and closed
    {
        use frontier_abi::layout::player::citizen as C;
        let mut f = w.fold.write().unwrap();
        set_citizen(&mut f, &c.a1, 1, C::FLAG_JOINED, 1_800_001_000);
    }
    assert_eq!(
        post(&w, &c.a2, 1, BELL0, &nonce(3), "after expulsion")
            .await
            .0,
        200
    );
    let m = next(&mut a).await.unwrap();
    assert_eq!(m, json!({"op": "error", "code": "Expelled"}));
    assert!(next(&mut a).await.is_none(), "closed");
    // an Origin of another site is refused at the upgrade
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", w.port))
        .await
        .unwrap();
    s.write_all(format!("GET /h/chat/ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n", w.port).as_bytes()).await.unwrap();
    let mut got = vec![0u8; 512];
    let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut got))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&got[..n]).starts_with("HTTP/1.1 403"));
    assert!(chat::authors(w.chat.as_ref().unwrap()).contains(&c.a2.bytes()));
}
