//! Shared helpers of the AC3b tests (`ai_follow_far.rs`, `ai_raid_recall.rs`,
//! `ai_social_post.rs`): a fake social service on `127.0.0.1:0` that checks
//! signed member reads like the real one (the signature must be the member's
//! session key's over the call-read bytes) and records every POST, and rigs
//! with the follow hook installed. Included with `#[path]` after
//! `ai_common.rs`; as a target of its own it holds no tests.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "ai_common.rs"]
pub mod common;

use common::*;
use fclient::Signer;
use frontier_agents::fixture::{self, NOW, SEED};
use frontier_agents::keys;
use frontier_agents::obs::b64;
use frontier_bots::ai::aislots::AiSlots;
use frontier_bots::ai::follow::SocialPort;
use frontier_bots::ai::{self, aisign, AiHook};
use frontier_bots::bot::{ClockSource, Config, Shared};
use frontier_bots::ports::NoDirect;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct SocialState {
    pub season: u64,
    /// `GET /f/ai/council?faction=F` answers by faction.
    pub council: BTreeMap<u8, Value>,
    /// The sealed Call a member reads.
    pub call: Option<Value>,
    /// Wallets that may read the Call; `None` = every registered wallet.
    pub members: Option<BTreeSet<String>>,
    /// A fixed refusal of every member read (status, code).
    pub refuse_call: Option<(u16, String)>,
    /// A fixed refusal of every POST (status, code).
    pub refuse_post: Option<(u16, String)>,
    /// Wallet (base58) → session key seed index (for the signature check).
    pub sessions: BTreeMap<String, u32>,
    pub gets: Vec<String>,
    pub posts: Vec<(String, Value)>,
    /// Member reads that passed the signature check.
    pub reads_ok: usize,
}

pub struct FakeSocial {
    pub addr: String,
    pub state: Arc<Mutex<SocialState>>,
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut o = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                o.push(v);
                i += 3;
                continue;
            }
        }
        o.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&o).to_string()
}

fn query_of(path: &str) -> BTreeMap<String, String> {
    path.split_once('?')
        .map(|(_, q)| {
            q.split('&')
                .filter_map(|kv| kv.split_once('='))
                .map(|(k, v)| (k.to_string(), percent_decode(v)))
                .collect()
        })
        .unwrap_or_default()
}

fn refusal(status: u16, code: &str) -> (u16, Value) {
    (
        status,
        json!({"error": code, "code": code, "detail": "fake social"}),
    )
}

/// What the real member read does, in order: parse, signature, membership,
/// a sealed Call.
fn member_read(st: &mut SocialState, path: &str) -> (u16, Value) {
    if let Some((s, c)) = st.refuse_call.clone() {
        return refusal(s, &c);
    }
    let q = query_of(path);
    let get = |k: &str| q.get(k).cloned().unwrap_or_default();
    let (Ok(faction), Ok(period), Ok(unix)) = (
        get("faction").parse::<u8>(),
        get("period").parse::<u32>(),
        get("unix").parse::<i64>(),
    ) else {
        return refusal(400, "BadBytes");
    };
    let wallet = get("wallet");
    let Some(&idx) = st.sessions.get(&wallet) else {
        return refusal(400, "NotEligible");
    };
    let Some(w) = aisign::key32(&wallet) else {
        return refusal(400, "BadBytes");
    };
    let bytes = aisign::encode_callread(&aisign::CallRead {
        season: st.season,
        faction,
        period,
        wallet: w,
        unix,
    });
    let want = keys::session(SEED, idx).sign_message(&bytes);
    let sig = b64(&get("sig")).unwrap_or_default();
    if sig != <[u8; 64]>::from(want).to_vec() {
        return refusal(400, "BadSignature");
    }
    st.reads_ok += 1;
    if st.members.as_ref().is_some_and(|m| !m.contains(&wallet)) {
        return refusal(400, "NotMember");
    }
    match &st.call {
        Some(c) if c["period"] == json!(period) => (200, c.clone()),
        _ => refusal(400, "WindowClosed"),
    }
}

impl FakeSocial {
    pub async fn start() -> FakeSocial {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let state = Arc::new(Mutex::new(SocialState {
            season: fixture::SEASON_ID,
            council: BTreeMap::new(),
            call: None,
            members: None,
            refuse_call: None,
            refuse_post: None,
            sessions: BTreeMap::new(),
            gets: vec![],
            posts: vec![],
            reads_ok: 0,
        }));
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let st = st.clone();
                tokio::spawn(async move {
                    let mut buf = vec![];
                    let mut tmp = [0u8; 4096];
                    let (head_end, len) = loop {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(i) = find(&buf, b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                            let len = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:"))
                                .and_then(|v| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            break (i + 4, len);
                        }
                    };
                    while buf.len() < head_end + len {
                        let n = s.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let first = head.lines().next().unwrap_or("").to_string();
                    let mut parts = first.split(' ');
                    let (method, path) = (
                        parts.next().unwrap_or("").to_string(),
                        parts.next().unwrap_or("").to_string(),
                    );
                    let body: Value = serde_json::from_slice(&buf[head_end..head_end + len])
                        .unwrap_or(Value::Null);
                    let (status, reply) = {
                        let mut g = st.lock().unwrap();
                        if method == "GET" {
                            g.gets.push(path.clone());
                            if path.starts_with("/f/ai/council/call") {
                                member_read(&mut g, &path)
                            } else if path.starts_with("/f/ai/council") {
                                let f: u8 = query_of(&path)
                                    .get("faction")
                                    .and_then(|x| x.parse().ok())
                                    .unwrap_or(255);
                                (
                                    200,
                                    g.council.get(&f).cloned().unwrap_or(json!({
                                        "period": null, "faction": f, "state": "none",
                                        "adopted": false, "sealed": false,
                                        "strike_bell": null, "follow_from": null, "call_commit": null
                                    })),
                                )
                            } else {
                                refusal(404, "NotFound")
                            }
                        } else {
                            g.posts.push((path.clone(), body));
                            match g.refuse_post.clone() {
                                Some((s, c)) => refusal(s, &c),
                                None => (200, json!({"ok": true, "id": g.posts.len()})),
                            }
                        }
                    };
                    let payload = serde_json::to_vec(&reply).unwrap();
                    let head = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = s.write_all(head.as_bytes()).await;
                    let _ = s.write_all(&payload).await;
                });
            }
        });
        FakeSocial { addr, state }
    }

    /// Lets the wallet of bot `index` read (its session key signs the reads).
    pub fn register(&self, index: u32) {
        let w = keys::wallet(SEED, index).pubkey().to_string();
        self.state.lock().unwrap().sessions.insert(w, index);
    }

    /// An adopted, sealed Call of `faction` period `period`.
    #[allow(clippy::too_many_arguments)]
    pub fn adopt(
        &self,
        faction: u8,
        period: u32,
        follow_from: u32,
        strike_bell: u32,
        kind: &str,
        target: (i16, i16, u8),
        invited: &[u64],
    ) {
        let mut g = self.state.lock().unwrap();
        g.council.insert(
            faction,
            json!({"period": period, "faction": faction, "state": "closed", "adopted": true,
                   "sealed": true, "follow_from": follow_from, "strike_bell": strike_bell,
                   "call_commit": "00"}),
        );
        g.call = Some(json!({
            "period": period, "option": 2, "kind": kind, "p": target.0, "q": target.1,
            "tile": target.2, "strike_bell": strike_bell, "follow_from": follow_from,
            "invited": invited.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
            "nonce": "ab".repeat(16), "call_commit": "00",
        }));
    }

    pub fn gets_of(&self, prefix: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .gets
            .iter()
            .filter(|g| g.starts_with(prefix))
            .count()
    }

    pub fn posts(&self) -> Vec<(String, Value)> {
        self.state.lock().unwrap().posts.clone()
    }
}

/// A rig with the AI hook installed, `follow_council` on or off, the social
/// service at `social` and an optional mind (the AI slots as given).
pub fn rig_follow(
    mind: Option<&FakeMind>,
    slots: &[(u32, &str)],
    social: &FakeSocial,
    follow_council: bool,
) -> Rig {
    let relay = Arc::new(MockRelay::new());
    let patch: Arc<Mutex<Option<Patch>>> = Arc::new(Mutex::new(None));
    let gets = Arc::new(Mutex::new(vec![]));
    let mut sh: Shared<PatchHerald, Relay, NoDirect> = Shared::new(
        PatchHerald {
            inner: herald(),
            patch: patch.clone(),
            gets: gets.clone(),
            units: true,
        },
        Relay(relay.clone()),
        None,
        Config::new(SEED),
        ClockSource::fixed(NOW),
    );
    let slots = if slots.is_empty() {
        AiSlots {
            seed: SEED,
            first_index: 1000,
            slots: vec![],
        }
    } else {
        AiSlots::parse(&slots_json(slots)).unwrap()
    };
    let mut hook = AiHook::new(slots, mind.map(|m| m.port()), follow_council);
    hook.fixed_call_budget = Duration::from_secs(5);
    hook.follow.social = SocialPort::new(&social.addr).unwrap();
    sh = ai::install(sh, hook);
    let hook = sh.ai.clone().unwrap();
    Rig {
        sh: Arc::new(sh),
        relay,
        hook,
        patch,
        gets,
    }
}

/// The id of the combat host `H1` of the fixture wallet (500 troops at home).
pub fn h1_id() -> u64 {
    fclient::addr::host_id(2, 0, 0, 1, 1).expect("host id")
}

/// The far camp of the fixture world: province (1, -2), three provinces from
/// the home (2, 0) and outside the bot's observation.
pub const FAR_CAMP: (i16, i16, u8) = (1, -2, 56);
