//! test-gaps-3: nation chat (`src/chat.rs`, #263) with NO key — the invariants verify-pr263 checked live and by the
//! key-using `tests/chat.rs` (never run by CI: its players derive keys and sign), replayed from literal records.
//!
//! `tests/vectors/chat-signed.json` holds posts and read tokens signed once, by hand, with the throwaway TEST wallets
//! of `tests/chat.rs` (`make-chat-signed.mjs`, key-using, not run here). This file only sends those bytes and lets the
//! herald verify them: no key is generated, derived or signed. The herald listens on 127.0.0.1:0 (an ephemeral port),
//! as the other in-process tests in CI do.
//!
//!   K1 the herald's text rules = the page's on the shared vectors (`chat-text-rules.json`, written by the page's
//!      test): the link rule and the refusal code agree on every text (fix-tg3, Q-TG3-1 (a): one explicit trim list
//!      and one invisible list on both sides, so U+FEFF / U+0085 no longer differ; was D-test-gaps-3-1)
//!   K2 the signed texts: `post_message` / `read_message` give every vector's message (the page's postText / readText
//!      give them too); the vectors name this fixture's world
//!   K3 twelve posts sent at once for one turn → exactly PER_TURN stored; nine signed across the ±1 turn window and
//!      sent at once → still PER_TURN (verify-pr263 F1)
//!   K4 40 per bell-day: 3 a turn for 14 turns → 40 stored, then DayLimit; the next bell-day posts again
//!   K5 a replayed post → Replay; again after a restart (the nonces rebuilt from the store, F2), and the counts too
//!   K6 nation-only: a nation-4 member's token claiming nation 1 → NotThisNation; a nation-1 token with its nation
//!      edited → BadSignature; each reader reads only its own nation's messages; a post signed for nation 1 sent as 4
//!      → BadSignature; signed for nation 1 by a nation-4 member → NotThisNation; a report on another nation's
//!      message → NoSuchMessage; an overflowing or over-long token window → BadTokenWindow (F3)
//!   K7 7-day expiry by the wall clock: kept until KEEP_MS, gone after (also across a restart)
//!   K8 (fog-leak-audit) a message id tells nothing of other nations: nation 1's ids step by NATIONS whatever nation 4
//!      posts between them, also across a restart (ids were one counter over every nation: the gaps counted the
//!      other nations' messages)

mod common;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

const T0_MS: u64 = 1_900_000_000_000;

fn signed() -> Value {
    serde_json::from_str(include_str!("vectors/chat-signed.json")).expect("chat-signed.json")
}

fn text_rules() -> Value {
    serde_json::from_str(include_str!("vectors/chat-text-rules.json"))
        .expect("chat-text-rules.json")
}

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

struct W {
    port: u16,
    fold: Arc<RwLock<Fold>>,
    chat: Arc<Chat>,
}

fn wallet_bytes(v: &Value, who: &str) -> [u8; 32] {
    let b = hex::decode(v["wallets"][who]["hex"].as_str().expect("wallet hex")).expect("hex");
    b.try_into().expect("32 bytes")
}

fn set_bell(f: &mut Fold, bell: u32) {
    f.live = Some((
        10_000 + u64::from(bell),
        fixture::GENESIS_TS + i64::from(bell) * 600 + 7,
    ));
}

/// Every vector wallet a joined citizen of its nation.
fn seat_cast(f: &mut Fold, v: &Value) {
    use frontier_abi::layout::player::citizen as C;
    for (who, w) in v["wallets"].as_object().expect("wallets") {
        let wallet = wallet_bytes(v, who);
        let mut d = vec![0u8; 384];
        d[..8].copy_from_slice(b"PSF1CITZ");
        d[C::WALLET..C::WALLET + 32].copy_from_slice(&wallet);
        d[C::FACTION] = u8::try_from(w["nation"].as_u64().expect("nation")).expect("u8");
        d[C::FLAGS] = C::FLAG_JOINED;
        let a = f.ctx.citizen(&wallet);
        f.st.accounts.insert(
            a,
            Capture {
                slot: 1,
                tx: 0,
                data: d,
            },
        );
    }
}

async fn world_in(dir: &std::path::Path, clock: Arc<AtomicU64>, v: &Value) -> W {
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
    set_bell(&mut f, v["bell0"].as_u64().expect("bell0") as u32);
    seat_cast(&mut f, v);
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
    let chat = Arc::new(
        Chat::open_with_clock(
            dir.join("chat"),
            None,
            Arc::new(move || c2.load(Ordering::SeqCst)),
        )
        .expect("chat store"),
    );
    app.chat = Some(chat.clone());
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind 127.0.0.1:0");
    let port = l.local_addr().expect("addr").port();
    tokio::spawn(server::serve(l, Arc::new(app)));
    W { port, fold, chat }
}

/// One request (Connection: close) → (status, JSON body or Null).
async fn http(port: u16, path: &str, body: &Value) -> (u16, Value) {
    let b = body.to_string();
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{b}",
        b.len()
    );
    let fut = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        s.write_all(req.as_bytes()).await.expect("write");
        let mut got = vec![];
        s.read_to_end(&mut got).await.expect("read");
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
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

fn code(v: &Value) -> &str {
    v["code"].as_str().unwrap_or("")
}

fn post_vec<'a>(v: &'a Value, id: &str) -> &'a Value {
    v["posts"]
        .as_array()
        .expect("posts")
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or_else(|| panic!("no post {id}"))
}

/// The body the page sends for a vector post (as signed: nothing changed).
fn post_body(v: &Value, id: &str) -> Value {
    let p = post_vec(v, id);
    let who = p["who"].as_str().expect("who");
    json!({"wallet": v["wallets"][who]["address"], "nation": p["nation"], "turn": p["turn"], "nonce": p["nonce"],
        "text": p["text"], "signature": p["signature"]})
}

fn token(v: &Value, id: &str) -> Value {
    let t = v["tokens"]
        .as_array()
        .expect("tokens")
        .iter()
        .find(|t| t["id"] == id)
        .unwrap_or_else(|| panic!("no token {id}"));
    let who = t["who"].as_str().expect("who");
    let n = |k: &str| -> i64 { t[k].as_str().expect("decimal").parse().expect("i64") };
    json!({"wallet": v["wallets"][who]["address"], "nation": t["nation"], "issued": n("issued"),
        "expires": n("expires"), "signature": t["signature"]})
}

async fn post(w: &W, body: &Value) -> (u16, Value) {
    http(w.port, "/h/chat/post", body).await
}

async fn read(w: &W, tok: &Value) -> (u16, Value) {
    http(w.port, "/h/chat/read", &json!({ "token": tok })).await
}

fn texts(v: &Value) -> Vec<String> {
    v["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| m["text"].as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn k1_text_rules_match_the_page_on_the_shared_vectors() {
    let v = text_rules();
    let cases = v["cases"].as_array().expect("cases");
    assert!(cases.len() > 2_500, "the shared corpus is there");
    for c in cases {
        let t = c["text"].as_str().expect("text");
        let page = c["problem"].as_str();
        let page_link = c["link"].as_bool().expect("link");
        assert_eq!(
            chat::link_in(t),
            page_link,
            "{t:?}: the link rule differs between the herald and the page"
        );
        // (fix-tg3: no exception any more — the herald and the page answer the same code for every text)
        assert_eq!(
            chat::text_problem(t),
            page,
            "{t:?}: the refusal differs between the herald and the page"
        );
    }
}

/// D-test-gaps-3-1, fixed by fix-tg3 (owner-default Q-TG3-1 (a); was `#[ignore]`d as expected to fail): the herald
/// refuses a post whose text is only U+FEFF or only other invisible characters (EmptyText, as the page), and texts that
/// begin or end with U+FEFF (UntrimmedText, as the page).
#[test]
fn k1_the_herald_refuses_a_text_of_only_u_feff() {
    assert_eq!(chat::text_problem("\u{feff}"), Some("EmptyText"));
    assert_eq!(chat::text_problem("hold\u{feff}"), Some("UntrimmedText"));
    assert_eq!(chat::text_problem("\u{feff}hold"), Some("UntrimmedText"));
    for t in [
        "\u{200b}",
        "\u{2060}",
        "\u{3164}",
        "\u{2800}",
        "\u{200b} \u{2060}\u{3164}\u{2800}",
    ] {
        assert_eq!(chat::text_problem(t), Some("EmptyText"), "{t:?}");
    }
    assert_eq!(
        chat::text_problem("a\u{200b}b"),
        None,
        "an invisible character inside a text is kept"
    );
}

#[test]
fn k2_the_signed_texts_are_the_vectors() {
    let v = signed();
    assert_eq!(v["world"]["season"], fixture::SEASON_ID);
    assert_eq!(v["world"]["program"], fixture::program().to_string());
    let w = World {
        season: fixture::SEASON_ID,
        program: fixture::program().to_string(),
    };
    let posts = v["posts"].as_array().expect("posts");
    assert!(posts.len() >= 60);
    for p in posts {
        let who = p["who"].as_str().expect("who");
        let m = chat::post_message(
            &w,
            p["nation"].as_u64().expect("nation") as u8,
            p["turn"].as_u64().expect("turn") as u32,
            p["nonce"].as_str().expect("nonce"),
            v["wallets"][who]["address"].as_str().expect("address"),
            p["text"].as_str().expect("text"),
        );
        assert_eq!(m, p["message"].as_str().expect("message"), "{}", p["id"]);
        assert_eq!(chat::text_problem(p["text"].as_str().expect("text")), None);
    }
    for t in v["tokens"].as_array().expect("tokens") {
        let who = t["who"].as_str().expect("who");
        let n = |k: &str| -> i64 { t[k].as_str().expect("decimal").parse().expect("i64") };
        let m = chat::read_message(
            &w,
            t["nation"].as_u64().expect("nation") as u8,
            v["wallets"][who]["address"].as_str().expect("address"),
            n("issued"),
            n("expires"),
        );
        assert_eq!(m, t["message"].as_str().expect("message"), "{}", t["id"]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn k3_parallel_posts_and_the_turn_window_store_per_turn() {
    let v = signed();
    let w = world_in(&tmp("chat-k3"), Arc::new(AtomicU64::new(T0_MS)), &v).await;
    let bell0 = v["bell0"].as_u64().expect("bell0");
    for (label, ids) in [
        (
            "twelve at once, one turn",
            (0..12).map(|i| format!("parallel-{i}")).collect::<Vec<_>>(),
        ),
        (
            "nine at once across turn-1, turn, turn+1",
            [bell0 - 1, bell0, bell0 + 1]
                .iter()
                .flat_map(|t| (0..3).map(move |i| format!("window-{t}-{i}")))
                .collect(),
        ),
    ] {
        let mut tasks = Vec::new();
        for id in &ids {
            let b = post_body(&v, id);
            let port = w.port;
            tasks.push(tokio::spawn(
                async move { http(port, "/h/chat/post", &b).await },
            ));
        }
        let mut ok = 0;
        let mut limited = 0;
        for t in tasks {
            let (s, r) = t.await.expect("task");
            match s {
                200 => ok += 1,
                429 => {
                    assert_eq!(code(&r), "TurnLimit", "{label}: {r}");
                    limited += 1;
                }
                _ => panic!("{label}: unexpected {s} {r}"),
            }
        }
        assert_eq!(ok, chat::PER_TURN, "{label}: stored");
        assert_eq!(ok + limited, ids.len(), "{label}: every post answered");
    }
    // what is stored is what was counted: 3 + 3, each from one signer, all taken in the herald's bell
    let kept = chat::kept(&w.chat, 1);
    assert_eq!(kept.len(), 2 * chat::PER_TURN);
    assert!(kept.iter().all(|m| u64::from(m.bell) == bell0));
}

#[tokio::test]
async fn k4_forty_per_bell_day_then_the_next_day() {
    let v = signed();
    let w = world_in(&tmp("chat-k4"), Arc::new(AtomicU64::new(T0_MS)), &v).await;
    let bell0 = v["bell0"].as_u64().expect("bell0") as u32;
    assert_eq!(
        bell0 / chat::BELLS_PER_DAY,
        (bell0 + 13) / chat::BELLS_PER_DAY,
        "one bell-day"
    );
    let mut ok = 0;
    let mut day_limited = Vec::new();
    for t in bell0..bell0 + 14 {
        set_bell(&mut w.fold.write().expect("fold"), t);
        for i in 0..3 {
            let (s, r) = post(&w, &post_body(&v, &format!("day-{t}-{i}"))).await;
            match s {
                200 => ok += 1,
                429 => {
                    assert_eq!(code(&r), "DayLimit", "turn {t} post {i}: {r}");
                    day_limited.push((t, i));
                }
                _ => panic!("turn {t} post {i}: {s} {r}"),
            }
        }
    }
    assert_eq!(ok, chat::PER_DAY);
    assert_eq!(day_limited, vec![(bell0 + 13, 1), (bell0 + 13, 2)]);
    // the next bell-day (432 = 3 × 144) posts again
    set_bell(&mut w.fold.write().expect("fold"), 432);
    let (s, r) = post(&w, &post_body(&v, "nextday")).await;
    assert_eq!(s, 200, "{r}");
}

#[tokio::test]
async fn k5_a_replay_is_refused_also_after_a_restart() {
    let v = signed();
    let dir = tmp("chat-k5");
    let clock = Arc::new(AtomicU64::new(T0_MS));
    let w = world_in(&dir, clock.clone(), &v).await;
    let b = post_body(&v, "b1-own");
    assert_eq!(post(&w, &b).await.0, 200);
    let (s, r) = post(&w, &b).await;
    assert_eq!((s, code(&r)), (409, "Replay"));
    for i in 0..2 {
        assert_eq!(
            post(&w, &post_body(&v, &format!("parallel-{i}"))).await.0,
            200
        );
    }
    // a restart: a new herald over the same store
    let w2 = world_in(&dir, clock, &v).await;
    let (s, r) = post(&w2, &b).await;
    assert_eq!(
        (s, code(&r)),
        (409, "Replay"),
        "replay after a restart (F2)"
    );
    let (s, r) = post(&w2, &post_body(&v, "parallel-0")).await;
    assert_eq!((s, code(&r)), (409, "Replay"));
    // the counts are rebuilt too: a2 has 2 of 3 this turn → one more, then TurnLimit
    assert_eq!(post(&w2, &post_body(&v, "parallel-2")).await.0, 200);
    let (s, r) = post(&w2, &post_body(&v, "parallel-3")).await;
    assert_eq!((s, code(&r)), (429, "TurnLimit"));
}

#[tokio::test]
async fn k6_a_nation_reads_and_reports_only_its_own_chat() {
    let v = signed();
    let w = world_in(&tmp("chat-k6"), Arc::new(AtomicU64::new(T0_MS)), &v).await;
    let (s, r) = post(&w, &post_body(&v, "day-300-0")).await;
    assert_eq!(s, 200, "{r}");
    let a1_msg = r["message"]["id"].clone();
    let (s, r) = post(&w, &post_body(&v, "b1-own")).await;
    assert_eq!(s, 200, "{r}");
    let b1_msg = r["message"]["id"].clone();
    // a post signed for nation 1, sent as nation 4: the signature names the nation
    let mut b = post_body(&v, "day-300-1");
    b["nation"] = json!(4);
    let (s, r) = post(&w, &b).await;
    assert_eq!((s, code(&r)), (401, "BadSignature"));
    // validly signed for nation 1 by a member of nation 4
    let (s, r) = post(&w, &post_body(&v, "b1-as-1")).await;
    assert_eq!((s, code(&r)), (403, "NotThisNation"));
    // reads
    let (s, r) = read(&w, &token(&v, "a1")).await;
    assert_eq!(s, 200, "{r}");
    assert_eq!(r["nation"], 1);
    assert_eq!(texts(&r), vec!["day 300 0".to_string()]);
    let (s, r) = read(&w, &token(&v, "b1")).await;
    assert_eq!(s, 200, "{r}");
    assert_eq!(texts(&r), vec!["dunmar only".to_string()]);
    let (s, r) = read(&w, &token(&v, "b1-claims-1")).await;
    assert_eq!((s, code(&r)), (403, "NotThisNation"));
    assert!(r["messages"].is_null(), "nothing of nation 1 in a refusal");
    let mut edited = token(&v, "a1");
    edited["nation"] = json!(4);
    let (s, r) = read(&w, &edited).await;
    assert_eq!((s, code(&r)), (401, "BadSignature"));
    for id in ["a1-overflow", "a1-13h"] {
        let (s, r) = read(&w, &token(&v, id)).await;
        assert_eq!((s, code(&r)), (401, "BadTokenWindow"), "{id}");
    }
    // a report on another nation's message is "no such message" (it reveals nothing)
    let (s, r) = http(
        w.port,
        "/h/chat/report",
        &json!({"token": token(&v, "b1"), "id": a1_msg, "reason": "spam"}),
    )
    .await;
    assert_eq!((s, code(&r)), (404, "NoSuchMessage"));
    let (s, r) = http(
        w.port,
        "/h/chat/report",
        &json!({"token": token(&v, "a1"), "id": b1_msg, "reason": "spam"}),
    )
    .await;
    assert_eq!((s, code(&r)), (404, "NoSuchMessage"));
    assert!(chat::reports(&w.chat).is_empty());
    // the stores: each nation's queue holds its own only
    assert_eq!(chat::kept(&w.chat, 1).len(), 1);
    assert_eq!(chat::kept(&w.chat, 4).len(), 1);
}

#[tokio::test]
async fn k7_messages_expire_after_seven_days_by_the_wall_clock() {
    let v = signed();
    let dir = tmp("chat-k7");
    let clock = Arc::new(AtomicU64::new(T0_MS));
    let w = world_in(&dir, clock.clone(), &v).await;
    assert_eq!(post(&w, &post_body(&v, "b1-own")).await.0, 200);
    clock.store(T0_MS + chat::KEEP_MS - 1, Ordering::SeqCst);
    assert_eq!(w.chat.prune_and_save(), 0);
    assert_eq!(chat::kept(&w.chat, 4).len(), 1, "kept until 7 days");
    let w2 = world_in(&dir, clock.clone(), &v).await;
    assert_eq!(chat::kept(&w2.chat, 4).len(), 1, "and across a restart");
    clock.store(T0_MS + chat::KEEP_MS, Ordering::SeqCst);
    assert_eq!(w2.chat.prune_and_save(), 1);
    assert!(chat::kept(&w2.chat, 4).is_empty(), "gone at 7 days");
    let w3 = world_in(&dir, clock, &v).await;
    assert!(chat::kept(&w3.chat, 4).is_empty(), "and stays gone");
}

#[tokio::test]
async fn k8_message_ids_tell_nothing_of_other_nations() {
    let nations = permutation_rules::frontier::structure::NATIONS as u64;
    let v = signed();
    let dir = tmp("chat-k8");
    let clock = Arc::new(AtomicU64::new(T0_MS));
    let w = world_in(&dir, clock.clone(), &v).await;
    let id_of = |r: &Value| -> u64 {
        r["message"]["id"]
            .as_str()
            .expect("id")
            .parse()
            .expect("u64")
    };
    let (s, r) = post(&w, &post_body(&v, "day-300-0")).await;
    assert_eq!(s, 200, "{r}");
    let a0 = id_of(&r);
    // nation 4 speaks between nation 1's two messages
    let (s, r) = post(&w, &post_body(&v, "b1-own")).await;
    assert_eq!(s, 200, "{r}");
    let b0 = id_of(&r);
    let (s, r) = post(&w, &post_body(&v, "day-300-1")).await;
    assert_eq!(s, 200, "{r}");
    let a1 = id_of(&r);
    assert_eq!(
        a1 - a0,
        nations,
        "nation 1's next id is not moved by nation 4's post"
    );
    assert_eq!((a0 % nations, a1 % nations, b0 % nations), (1, 1, 4));
    // after a restart nation 1 goes on from its own numbers
    drop(w);
    let w2 = world_in(&dir, clock.clone(), &v).await;
    let (s, r) = post(&w2, &post_body(&v, "day-300-2")).await;
    assert_eq!(s, 200, "{r}");
    assert_eq!(id_of(&r), a1 + nations);
    let (s, r) = read(&w2, &token(&v, "a1")).await;
    assert_eq!(s, 200, "{r}");
    let got: Vec<String> = r["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|m| m["id"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(got, [a0, a1, a1 + nations].map(|i| i.to_string()));
}
