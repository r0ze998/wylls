//! Shared test helpers of the `ai_*` tests (contract §11.3 AC3a): a mock
//! relay that records what the bots sent, a fake mind on `127.0.0.1:0`, and
//! a rig that runs one AI bot (wallet `FINAL` of the agents fixture world)
//! against the recorded herald files. Included with `#[path]` by every
//! `ai_*.rs` test; as a target of its own it holds no tests.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fclient::abi::tag;
use fclient::ports::PortError;
use fclient::{Address, Hash, Keypair, Signer};
use frontier_agents::fixture::{self, FINAL, NOW, SEED};
use frontier_agents::obs::b64;
use frontier_agents::profile::{AgentSpec, Arch};
use frontier_bots::ai::aislots::AiSlots;
use frontier_bots::ai::mindport::MindPort;
use frontier_bots::ai::{self, AiHook};
use frontier_bots::bot::{Bot, ClockSource, Config, Shared};
use frontier_bots::ports::{Answer, DirHerald, NoDirect, RelayPort};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const TOKEN: &str = "test-token";
/// The signature the mock relay answers with (so a golden outcome is stable).
pub const SIG: &str =
    "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CTJTqixU2fuSdnuHBPzqSXRhSF4X6pRTxZLkZV7TeJAQ3FrbdNJRDaYtCk";

pub struct Posted {
    pub path: String,
    pub tag: u8,
    pub body: Value,
}

pub struct MockRelay {
    pub fee_payer: Keypair,
    pub posts: Mutex<Vec<Posted>>,
    pub refuse_tags: Mutex<Vec<u8>>,
}

impl MockRelay {
    pub fn new() -> MockRelay {
        MockRelay {
            fee_payer: Keypair::new_from_array([0xFE; 32]),
            posts: Mutex::new(vec![]),
            refuse_tags: Mutex::new(vec![]),
        }
    }

    /// The instruction tags of the sponsored transactions sent so far.
    pub fn tags(&self) -> Vec<u8> {
        self.posts
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.path == "/f/relay" || p.path == "/f/join")
            .map(|p| p.tag)
            .collect()
    }

    pub fn count_tag(&self, t: u8) -> usize {
        self.tags().iter().filter(|x| **x == t).count()
    }

    pub fn paths(&self) -> Vec<String> {
        self.posts
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.path.clone())
            .collect()
    }
}

#[derive(Clone)]
pub struct Relay(pub Arc<MockRelay>);

impl RelayPort for Relay {
    async fn get(&self, path: &str) -> Result<Answer, PortError> {
        assert!(path.starts_with("/f/relay"), "{path}");
        Ok(Answer::new(
            200,
            json!({
                "feePayer": self.0.fee_payer.pubkey().to_string(),
                "blockhash": Hash::new_from_array([7; 32]).to_string(),
                "lastValidBlockHeight": 1_000,
                "programId": fixture::program().to_string(),
            }),
        ))
    }
    async fn post(&self, path: &str, body: &Value) -> Result<Answer, PortError> {
        let mut t = 0u8;
        if let Some(wire) = body
            .get("tx")
            .and_then(|x| x.as_str())
            .and_then(|s| b64(s).ok())
        {
            if let Ok(tx) = fclient::tx::from_wire(&wire) {
                if let Some(ix) = tx.message.instructions.last() {
                    t = ix.data[0];
                }
            }
        }
        self.0.posts.lock().unwrap().push(Posted {
            path: path.to_string(),
            tag: t,
            body: body.clone(),
        });
        if self.0.refuse_tags.lock().unwrap().contains(&t) {
            return Ok(Answer::new(
                400,
                json!({"error": "Refused", "code": "Refused"}),
            ));
        }
        Ok(match path {
            "/f/reveal" => Answer::new(202, json!({"accepted": true, "track": "t1"})),
            "/f/nudge" => Answer::new(200, json!({"ok": true})),
            _ => Answer::new(200, json!({"ok": true, "signature": SIG})),
        })
    }
}

// ------------------------------------------------------------------ fake mind

type AnswerFn = Box<dyn Fn(&Value) -> Value + Send + Sync>;
type HookFn = Box<dyn Fn(&Value) + Send + Sync>;

pub struct FakeMind {
    pub addr: String,
    pub requests: Arc<Mutex<Vec<Value>>>,
    pub outcomes: Arc<Mutex<Vec<Value>>>,
    pub unauthorised: Arc<AtomicUsize>,
    pub delay: Arc<Mutex<Duration>>,
    pub on_decide: Arc<Mutex<Option<HookFn>>>,
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

impl FakeMind {
    /// Starts the server; `answer` makes the `/v1/decide` answer from the request.
    pub async fn start(answer: impl Fn(&Value) -> Value + Send + Sync + 'static) -> FakeMind {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let requests = Arc::new(Mutex::new(vec![]));
        let outcomes = Arc::new(Mutex::new(vec![]));
        let unauthorised = Arc::new(AtomicUsize::new(0));
        let delay = Arc::new(Mutex::new(Duration::ZERO));
        let on_decide: Arc<Mutex<Option<HookFn>>> = Arc::new(Mutex::new(None));
        let answer: Arc<AnswerFn> = Arc::new(Box::new(answer));
        let (rq, oc, ua, dl, od) = (
            requests.clone(),
            outcomes.clone(),
            unauthorised.clone(),
            delay.clone(),
            on_decide.clone(),
        );
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let (rq, oc, ua, dl, od, answer) = (
                    rq.clone(),
                    oc.clone(),
                    ua.clone(),
                    dl.clone(),
                    od.clone(),
                    answer.clone(),
                );
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
                    let auth_ok = head.contains(&format!("Authorization: Bearer {TOKEN}"));
                    let body: Value =
                        serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
                    let (status, reply) = if !auth_ok {
                        ua.fetch_add(1, Ordering::SeqCst);
                        (401, json!({"error": "unauthorised"}))
                    } else if first.starts_with("POST /v1/decide") {
                        if let Some(f) = od.lock().unwrap().as_ref() {
                            f(&body);
                        }
                        let d = *dl.lock().unwrap();
                        if !d.is_zero() {
                            tokio::time::sleep(d).await;
                        }
                        let r = answer(&body);
                        rq.lock().unwrap().push(body);
                        (200, r)
                    } else if first.starts_with("POST /v1/outcome") {
                        oc.lock().unwrap().push(body);
                        (200, json!({"ok": true}))
                    } else {
                        (404, json!({"error": "not found"}))
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
        FakeMind {
            addr,
            requests,
            outcomes,
            unauthorised,
            delay,
            on_decide,
        }
    }

    pub fn port(&self) -> MindPort {
        MindPort::new(self.addr.clone(), TOKEN)
    }

    pub fn n_requests(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

/// A `mode:"autopilot"` answer (what a closed gate returns).
pub fn autopilot_answer(reason: &str) -> Value {
    json!({"v": 1, "decision_id": "d-test", "mode": "autopilot", "reason": reason,
           "choice": {"ids": ["c1"], "params": {}, "mem": []},
           "standing": {"reserved": [], "declined_calls": []},
           "caps": {"march_troops_left": null, "home_floor": null},
           "social": {"say": [], "motion": null, "ballot": null}})
}

/// A `mode:"model"` answer choosing `ids` (params per id).
pub fn model_answer(ids: &[&str], params: Value) -> Value {
    json!({"v": 1, "decision_id": "d-test", "mode": "model", "reason": "ok",
           "choice": {"ids": ids, "params": params, "mem": []},
           "standing": {"reserved": [], "declined_calls": []},
           "caps": {"march_troops_left": null, "home_floor": null},
           "social": {"say": [], "motion": null, "ballot": null}})
}

/// The id of the first candidate whose kind starts with `kind`.
pub fn cand_id(req: &Value, kind: &str) -> Option<String> {
    req["candidates"]
        .as_array()?
        .iter()
        .find(|c| c["kind"].as_str().is_some_and(|k| k.starts_with(kind)))
        .and_then(|c| c["id"].as_str().map(String::from))
}

// ------------------------------------------------------------------ rig

pub fn slots_json(indices: &[(u32, &str)]) -> String {
    json!({
        "v": 1, "seed": SEED, "first_index": 0,
        "slots": indices.iter().map(|(i, k)| json!({"index": i, "faction": 0, "join_bell": 5, "kind": k})).collect::<Vec<_>>(),
    })
    .to_string()
}

pub fn herald() -> DirHerald {
    DirHerald::new(fixture::dir())
}

pub fn spec(i: u32, arch: Arch) -> AgentSpec {
    AgentSpec {
        index: i,
        arch,
        faction: 0,
        join_day: 0,
        join_bell: 5,
        persona: None,
    }
}

pub type TestShared = Shared<DirHerald, Relay, NoDirect>;

pub struct Rig {
    pub sh: Arc<TestShared>,
    pub relay: Arc<MockRelay>,
    pub hook: Arc<AiHook>,
}

/// A shared environment over the fixture herald with the brain installed
/// (`mind` None = no mind configured).
pub fn rig(mind: Option<&FakeMind>, slots: &[(u32, &str)]) -> Rig {
    let relay = Arc::new(MockRelay::new());
    let mut sh: TestShared = Shared::new(
        herald(),
        Relay(relay.clone()),
        None,
        Config::new(SEED),
        ClockSource::fixed(NOW),
    );
    let slots = AiSlots::parse(&slots_json(slots)).unwrap();
    sh = ai::install(sh, AiHook::new(slots, mind.map(|m| m.port()), false));
    let hook = sh.ai.clone().unwrap();
    Rig {
        sh: Arc::new(sh),
        relay,
        hook,
    }
}

/// The AI bot of the fixture's final wallet.
pub fn ai_bot() -> Bot {
    let mut b = Bot::new(spec(FINAL, Arch::Skilled), SEED);
    b.ai.on = true;
    b
}

pub fn tags_of(v: &[Value]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

pub fn depart_count(r: &MockRelay) -> usize {
    r.count_tag(tag::DEPART)
}

pub fn _unused(_: BTreeMap<u8, u8>, _: Address) {}
