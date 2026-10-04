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
use frontier_bots::ports::{Answer, DirHerald, HeraldPort, NoDirect, RelayPort};
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

impl Default for MockRelay {
    fn default() -> Self {
        MockRelay::new()
    }
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
    /// The bodies of `POST /v1/brain-stats` (AC10a, R5/R6).
    pub brain_stats: Arc<Mutex<Vec<Value>>>,
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
        let brain_stats = Arc::new(Mutex::new(vec![]));
        let unauthorised = Arc::new(AtomicUsize::new(0));
        let delay = Arc::new(Mutex::new(Duration::ZERO));
        let on_decide: Arc<Mutex<Option<HookFn>>> = Arc::new(Mutex::new(None));
        let answer: Arc<AnswerFn> = Arc::new(Box::new(answer));
        let (rq, oc, ua, dl, od, bs) = (
            requests.clone(),
            outcomes.clone(),
            unauthorised.clone(),
            delay.clone(),
            on_decide.clone(),
            brain_stats.clone(),
        );
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let (rq, oc, ua, dl, od, bs, answer) = (
                    rq.clone(),
                    oc.clone(),
                    ua.clone(),
                    dl.clone(),
                    od.clone(),
                    bs.clone(),
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
                    let body: Value = serde_json::from_slice(&buf[head_end..head_end + len])
                        .unwrap_or(Value::Null);
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
                    } else if first.starts_with("POST /v1/brain-stats") {
                        bs.lock().unwrap().push(body);
                        (200, json!({"ok": true, "applied": true}))
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
            brain_stats,
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

pub type Patch = Box<dyn Fn(&str, Vec<u8>) -> Vec<u8> + Send + Sync>;

/// The fixture herald with an optional per-file patch (a test changes what a
/// later read sees) and a log of every path read.
pub struct PatchHerald {
    pub inner: DirHerald,
    pub patch: Arc<Mutex<Option<Patch>>>,
    pub gets: Arc<Mutex<Vec<String>>>,
    /// Scale the agents fixture's whole troops to the chain's milli-troops
    /// (off for files recorded from a real herald).
    pub units: bool,
}

impl HeraldPort for PatchHerald {
    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, PortError> {
        self.gets.lock().unwrap().push(path.to_string());
        let r = self.inner.get(path).await?;
        Ok(r.map(|b| {
            let b = if self.units { chain_units(path, b) } else { b };
            match self.patch.lock().unwrap().as_ref() {
                Some(f) => f(path, b),
                None => b,
            }
        }))
    }
}

/// The agents' fixture world writes troops as whole numbers where the chain
/// stores `MilliTroops` (a real herald serves a 100-troop host as 100000;
/// `Entry.troops`, a site mirror's `garrison` and `Transit.dep_mass`). Every
/// read through the rig scales them to the chain's unit, so the brain sees
/// what it sees on a real herald (a 500-troop host is 500000 milli).
pub fn chain_units(path: &str, b: Vec<u8>) -> Vec<u8> {
    use fclient::abi::layout as l;
    let scale = |bytes: &mut Vec<u8>, o: usize| {
        let v = u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        bytes[o..o + 4].copy_from_slice(&(v * 1000).to_le_bytes());
    };
    if path.starts_with("/h/province/") {
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        let mut bytes = b64(v["bytes"].as_str().unwrap()).unwrap();
        for i in 0..56 {
            scale(
                &mut bytes,
                l::province::ENTRIES + i * l::province::ENTRY_STRIDE + l::entry::TROOPS,
            );
        }
        for s in 0..12 {
            scale(
                &mut bytes,
                l::province::SITE_MIRROR + s * l::province::SITE_MIRROR_STRIDE + l::site::GARRISON,
            );
        }
        v["bytes"] = json!(frontier_agents::obs::b64_encode(&bytes));
        return serde_json::to_vec(&v).unwrap();
    }
    if path.starts_with("/h/me/") {
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        if let Some(hs) = v["holdings"].as_array_mut() {
            for h in hs {
                let mut bytes = b64(h["bytes_b64"].as_str().unwrap()).unwrap();
                for i in 0..4 {
                    scale(
                        &mut bytes,
                        l::holding::TRANSIT + i * l::holding::TRANSIT_STRIDE + l::transit::DEP_MASS,
                    );
                }
                h["bytes_b64"] = json!(frontier_agents::obs::b64_encode(&bytes));
            }
        }
        return serde_json::to_vec(&v).unwrap();
    }
    b
}

/// Patches the JSON of `/h/me/*`: sets `quota.left`.
pub fn patch_quota(left: u32) -> Patch {
    Box::new(move |path, b| {
        if !path.starts_with("/h/me/") {
            return b;
        }
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        v["quota"]["left"] = json!(left);
        serde_json::to_vec(&v).unwrap()
    })
}

/// Patches every province file's account bytes with `f`.
pub fn patch_province(f: impl Fn(&mut Vec<u8>) + Send + Sync + 'static) -> Patch {
    Box::new(move |path, b| {
        if !path.starts_with("/h/province/") {
            return b;
        }
        let mut v: Value = serde_json::from_slice(&b).unwrap();
        let mut bytes = b64(v["bytes"].as_str().unwrap()).unwrap();
        f(&mut bytes);
        v["bytes"] = json!(frontier_agents::obs::b64_encode(&bytes));
        serde_json::to_vec(&v).unwrap()
    })
}

/// Kills every barbarian camp in the province files.
pub fn patch_no_camps() -> Patch {
    patch_province(|bytes| {
        bytes[fclient::abi::layout::province::CAMP + 1] = 0;
    })
}

/// Sets every province's `resolved_next`.
pub fn patch_resolved(n: u32) -> Patch {
    patch_province(move |bytes| {
        let o = fclient::abi::layout::province::RESOLVED_NEXT;
        bytes[o..o + 4].copy_from_slice(&n.to_le_bytes());
    })
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

pub type TestShared = Shared<PatchHerald, Relay, NoDirect>;

pub struct Rig {
    pub sh: Arc<TestShared>,
    pub relay: Arc<MockRelay>,
    pub hook: Arc<AiHook>,
    pub patch: Arc<Mutex<Option<Patch>>>,
    pub gets: Arc<Mutex<Vec<String>>>,
}

impl Rig {
    pub fn set_patch(&self, p: Option<Patch>) {
        *self.patch.lock().unwrap() = p;
    }

    pub fn gets_of(&self, prefix: &str) -> usize {
        self.gets
            .lock()
            .unwrap()
            .iter()
            .filter(|g| g.starts_with(prefix))
            .count()
    }
}

/// A shared environment over the fixture herald with the brain installed
/// (`mind` None = no mind configured).
pub fn rig(mind: Option<&FakeMind>, slots: &[(u32, &str)]) -> Rig {
    rig_budget(mind, slots, Duration::from_secs(5))
}

pub fn rig_budget(mind: Option<&FakeMind>, slots: &[(u32, &str)], budget: Duration) -> Rig {
    let relay = Arc::new(MockRelay::new());
    let patch: Arc<Mutex<Option<Patch>>> = Arc::new(Mutex::new(None));
    let gets = Arc::new(Mutex::new(vec![]));
    let mut sh: TestShared = Shared::new(
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
    let slots = AiSlots::parse(&slots_json(slots)).unwrap();
    let mut hook = AiHook::new(slots, mind.map(|m| m.port()), false);
    hook.fixed_call_budget = budget;
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

/// Marks every observed province resolved through the observation's bell
/// (the files are static; a resident action is refused `NotResident`
/// otherwise once the clock moves past bell 41).
pub fn resolve_all(o: &mut frontier_agents::obs::Observation) {
    let b = o.bell();
    for v in o.provinces.values_mut() {
        v.province.resolved_next = b;
    }
}

/// A shared environment without any AI hook (the rule bots' path).
pub fn rig_plain() -> (Arc<TestShared>, Arc<MockRelay>) {
    let (sh, relay, _) = rig_plain_patch();
    (sh, relay)
}

pub fn rig_plain_patch() -> (Arc<TestShared>, Arc<MockRelay>, Arc<Mutex<Option<Patch>>>) {
    let relay = Arc::new(MockRelay::new());
    let patch: Arc<Mutex<Option<Patch>>> = Arc::new(Mutex::new(None));
    let sh: TestShared = Shared::new(
        PatchHerald {
            inner: herald(),
            patch: patch.clone(),
            gets: Arc::new(Mutex::new(vec![])),
            units: true,
        },
        Relay(relay.clone()),
        None,
        Config::new(SEED),
        ClockSource::fixed(NOW),
    );
    (Arc::new(sh), relay, patch)
}

/// The AI bot of the fixture's final wallet.
pub fn ai_bot() -> Bot {
    let mut b = Bot::new(spec(FINAL, Arch::Skilled), SEED);
    b.ai.on = true;
    b
}

pub fn depart_count(r: &MockRelay) -> usize {
    r.count_tag(tag::DEPART)
}

pub fn _unused(_: BTreeMap<u8, u8>, _: Address) {}

/// A rig over files recorded from a real herald (`permutation-gateway/test/
/// fixtures/ai-brain-real`, bots seed 1) at game time `now`.
pub fn rig_real(mind: Option<&FakeMind>, slots: &[(u32, &str)], now: i64) -> Rig {
    let relay = Arc::new(MockRelay::new());
    let patch: Arc<Mutex<Option<Patch>>> = Arc::new(Mutex::new(None));
    let gets = Arc::new(Mutex::new(vec![]));
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-gateway/test/fixtures/ai-brain-real");
    let mut sh: TestShared = Shared::new(
        PatchHerald {
            inner: DirHerald::new(dir),
            patch: patch.clone(),
            gets: gets.clone(),
            units: false,
        },
        Relay(relay.clone()),
        None,
        Config::new(1),
        ClockSource::fixed(now),
    );
    let mut j: Value = serde_json::from_str(&slots_json(slots)).unwrap();
    j["seed"] = json!(1);
    let slots = AiSlots::parse(&j.to_string()).unwrap();
    sh = ai::install(sh, AiHook::new(slots, mind.map(|m| m.port()), false));
    let hook = sh.ai.clone().unwrap();
    Rig {
        sh: Arc::new(sh),
        relay,
        hook,
        patch,
        gets,
    }
}

/// The Rust-side shape check of a `/v1/decide` request (§4.1-4.3), the same
/// keys the Node schema test checks on the golden fixture.
pub fn check_request_shape(r: &Value) {
    assert_eq!(r["v"], 1);
    for k in ["index", "wallet", "tag"] {
        assert!(r["ai"].get(k).is_some(), "ai.{k}");
    }
    assert_eq!(r["ai"]["tag"].as_str().unwrap().len(), 16);
    assert!(r["ai"]["tag"]
        .as_str()
        .unwrap()
        .bytes()
        .all(|b| b.is_ascii_hexdigit()));
    for k in ["bell", "now_game", "scale", "deadline_unix_ms"] {
        assert!(r[k].is_number(), "{k}");
    }
    assert!(r["wake_hints"].is_array());
    assert_eq!(r["obs_digest"].as_str().unwrap().len(), 64);
    let c = r["candidates"].as_array().unwrap();
    assert!(!c.is_empty() && c.len() <= 12);
    for (i, x) in c.iter().enumerate() {
        assert_eq!(x["id"], format!("c{}", i + 1));
        for k in ["kind", "label"] {
            assert!(x[k].is_string(), "candidate {k}");
        }
        assert!(x["facts"].is_object() && x["params"].is_object() && x["flags"].is_object());
        assert!(x["entities"].is_array());
    }
    assert_eq!(c[0]["kind"], "autopilot");
    assert_eq!(c[1]["kind"], "hold");
    for k in ["bell", "day", "bell_in_day", "secs_left", "end_bell"] {
        assert!(r["situation"][k].is_number(), "situation.{k}");
    }
    let me = &r["situation"]["me"];
    for k in [
        "faction",
        "doctrine",
        "home",
        "stores",
        "rates_per_hour",
        "queue",
        "reserve",
        "garrison",
        "home_troops",
        "home_troops_day_start",
        "hosts",
        "explore",
        "muster_room",
        "quota",
    ] {
        assert!(me.get(k).is_some(), "situation.me.{k}");
    }
    assert_eq!(me["stores"].as_array().unwrap().len(), 8);
    assert_eq!(me["reserve"].as_array().unwrap().len(), 7);
    for h in me["hosts"].as_array().unwrap() {
        assert!(h["host_id"].is_string() && h["handle"].as_str().unwrap().starts_with('H'));
    }
    assert!(r["situation"]["neighbourhood"].is_array());
    assert!(r["situation"]["my_clashes"].is_array());
    assert!(r["own_marches"].is_array());
    assert!(r["autopilot"]["summary"].is_string() && r["autopilot"]["has_military"].is_boolean());
    assert!(r["autopilot"]["departs"].is_array());
}
