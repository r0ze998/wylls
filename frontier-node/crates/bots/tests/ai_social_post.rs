//! The brain posts what the mind's answer carries for the social layer
//! (contract §8.1, §6.1; unit AC3b): it fills `wallet`, encodes with
//! `aisign.rs`, signs with the **session key** (never the wallet key) and
//! POSTs `{bytes_b64, sig_b64, decision_id, item}` to `/f/ai/talk` or
//! `/f/ai/ballot`; a decision is posted at most once; refusals are counted
//! and never retried; nothing that fails to encode is signed.

#[path = "ai_follow_common.rs"]
mod fc;

use fc::common::*;
use fc::*;
use fclient::Signer;
use frontier_agents::fixture::{FINAL, SEED};
use frontier_agents::keys;
use frontier_agents::obs::b64;
use frontier_bots::ai::aisign::{self, Record, TalkTarget};
use serde_json::{json, Value};

fn answer_with_social(social: Value) -> Value {
    let mut a = model_answer(&["c1"], json!({}));
    a["mode"] = json!("model");
    a["social"] = social;
    a
}

fn say(item: u32, text: &str) -> Value {
    json!({"season": "1", "bell": 40, "seq": 640 + item, "channel": 1, "target": 0,
           "kind": 0, "ref": 0, "origin": 1, "lang": "en", "text": text, "item": item})
}

fn motion() -> Value {
    json!({"season": 1, "bell": 40, "seq": 650, "channel": 1, "target": 0, "kind": 1,
           "ref": 5 * 256 + 2, "origin": 1, "lang": "en", "text": "I move option 2.", "item": 0})
}

fn ballot() -> Value {
    json!({"season": 1, "period": 5, "faction": 0, "option": 2,
           "candidates_hash": "ab".repeat(32), "nonce": "cd".repeat(16), "origin": 1, "item": 0})
}

#[tokio::test]
async fn say_motion_and_ballot_are_signed_with_the_session_key_and_posted_once() {
    let social = FakeSocial::start().await;
    let ans = answer_with_social(json!({
        "say": [say(0, "Good morning."), say(1, "We hold the river.")],
        "motion": motion(),
        "ballot": ballot(),
    }));
    let fm = FakeMind::start(move |_| ans.clone()).await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let posts = social.posts();
    let paths: Vec<&str> = posts.iter().map(|p| p.0.as_str()).collect();
    assert_eq!(
        paths,
        ["/f/ai/talk", "/f/ai/talk", "/f/ai/talk", "/f/ai/ballot"]
    );
    let wallet = keys::wallet(SEED, FINAL);
    let session = keys::session(SEED, FINAL);
    for (n, (path, body)) in posts.iter().enumerate() {
        let bytes = b64(body["bytes_b64"].as_str().unwrap()).unwrap();
        let sig = b64(body["sig_b64"].as_str().unwrap()).unwrap();
        assert_eq!(sig.len(), 64);
        // The session key signed it, not the wallet key.
        assert_eq!(
            sig,
            <[u8; 64]>::from(session.sign_message(&bytes)).to_vec(),
            "{path}"
        );
        assert_ne!(sig, <[u8; 64]>::from(wallet.sign_message(&bytes)).to_vec());
        // The provenance fields of §6.2 rule 4.
        assert_eq!(body["decision_id"], "d-test");
        let want_item = [0, 1, 0, 0][n];
        assert_eq!(body["item"], want_item, "{path} #{n}");
        match aisign::decode(&bytes).expect("a live record") {
            Record::Talk(t) => {
                assert_eq!(
                    t.wallet,
                    wallet.pubkey().to_bytes(),
                    "the brain fills the wallet"
                );
                assert_eq!((t.origin, t.target), (1, TalkTarget::Nation(0)));
                assert!(t.season == 1 && t.bell == 40);
                if n == 2 {
                    assert_eq!((t.kind, t.reference), (1, 5 * 256 + 2), "the motion");
                }
            }
            Record::Ballot(b) => {
                assert_eq!(b.wallet, wallet.pubkey().to_bytes());
                assert_eq!((b.period, b.faction, b.option, b.origin), (5, 0, 2, 1));
            }
            Record::CallRead(_) => panic!("never posted as a talk or a ballot"),
        }
    }
    assert_eq!(r.hook.stat_of("social_posted:talk"), 3);
    assert_eq!(r.hook.stat_of("social_posted:ballot"), 1);
    // A same-bell repeat reuses the cached answer and posts nothing again.
    bot.step(&r.sh, true).await;
    assert_eq!(social.posts().len(), 4);
}

#[tokio::test]
async fn a_refusal_is_counted_and_never_retried_and_the_actions_still_go_out() {
    let social = FakeSocial::start().await;
    social.state.lock().unwrap().refuse_post = Some((400, "NotFromMind".into()));
    let mut ans =
        answer_with_social(json!({"say": [say(0, "Hello.")], "motion": null, "ballot": null}));
    ans["choice"]["ids"] = json!(["c1"]);
    let fm = FakeMind::start(move |_| ans.clone()).await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, false);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(social.posts().len(), 1, "one try");
    assert_eq!(r.hook.stat_of("social_refused:NotFromMind"), 1);
    assert_eq!(r.hook.stat_of("social_posted:talk"), 0);
    assert!(
        !r.relay.tags().is_empty(),
        "the economy and duties still ran"
    );
    bot.step(&r.sh, true).await;
    assert_eq!(
        social.posts().len(),
        1,
        "not retried on a repeat of the same decision"
    );
}

#[tokio::test]
async fn nothing_that_fails_to_encode_is_signed() {
    let social = FakeSocial::start().await;
    let ans = answer_with_social(json!({
        // Over 280 code points, an empty text, a null candidates hash, a motion for option 0.
        "say": [say(0, &"a".repeat(281)), say(1, "  "), say(2, "Fine.")],
        "motion": {"season": 1, "bell": 40, "seq": 650, "channel": 1, "target": 0, "kind": 1,
                    "ref": 0, "origin": 1, "lang": "en", "text": "I move nothing.", "item": 0},
        "ballot": {"season": 1, "period": 5, "faction": 0, "option": 2, "candidates_hash": null,
                    "nonce": "cd".repeat(16), "origin": 1, "item": 0},
    }));
    let fm = FakeMind::start(move |_| ans.clone()).await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, false);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    let posts = social.posts();
    assert_eq!(posts.len(), 1, "only the good message went out");
    assert_eq!(posts[0].1["item"], 2);
    assert_eq!(r.hook.stat_of("social_unsignable:TextTooLong"), 1);
    assert_eq!(r.hook.stat_of("social_unsignable:BadBytes"), 3);
}

#[tokio::test]
async fn a_down_social_service_does_not_stop_the_step_and_an_empty_social_posts_nothing() {
    let mut dead = FakeSocial::start().await;
    {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        dead.addr = l.local_addr().unwrap().to_string();
        drop(l);
    }
    let ans =
        answer_with_social(json!({"say": [say(0, "Hello.")], "motion": null, "ballot": null}));
    let fm = FakeMind::start(move |_| ans.clone()).await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &dead, false);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(r.hook.stat_of("social_post_failed"), 1);
    assert!(!r.relay.tags().is_empty());
    // An empty social posts nothing, and a closed-gate answer has none.
    let social = FakeSocial::start().await;
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig_follow(Some(&fm), &[(FINAL, "ai")], &social, false);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert!(social.posts().is_empty());
}

#[tokio::test]
async fn the_wallet_key_is_never_used_to_sign_a_call_read() {
    // The member read is signed by the session key (the social service checks
    // it against the Citizen's session): the fake verifies exactly that.
    let social = FakeSocial::start().await;
    social.register(FINAL);
    social.adopt(0, 5, 40, 52, "camp", FAR_CAMP, &[h1_id()]);
    let r = rig_follow(None, &[(FINAL, "ai")], &social, true);
    let mut bot = ai_bot();
    bot.step(&r.sh, true).await;
    assert_eq!(
        social.state.lock().unwrap().reads_ok,
        1,
        "the session key's signature verified"
    );
    // A read signed by the wallet key would not have: the fake recomputes
    // the session signature, so a different key is `BadSignature`.
    let bytes = aisign::encode_callread(&aisign::CallRead {
        season: 1,
        faction: 0,
        period: 5,
        wallet: keys::wallet(SEED, FINAL).pubkey().to_bytes(),
        unix: 1,
    });
    let by_wallet = aisign::sign_record(&bytes, &keys::wallet(SEED, FINAL)).unwrap();
    let by_session = aisign::sign_record(&bytes, &keys::session(SEED, FINAL)).unwrap();
    assert_ne!(by_wallet.sig, by_session.sig);
}
