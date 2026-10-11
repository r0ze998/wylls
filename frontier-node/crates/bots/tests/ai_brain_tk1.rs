//! T-K1 (contract §4.1): the brain never sends private keys, seeds, salts,
//! seal plaintexts, the bot journal, or the destination of an own march that
//! has departed and not yet arrived. 1,000 requests (and the outcomes) of
//! an in-process run are serialised and scanned for the forbidden byte
//! strings: the secret keys (hex, base64, base58 and raw), the seed as
//! little-endian bytes, and every seal salt and plaintext of the marchbook.
//!
//! Limit: the fixture world's seed is 7, a decimal too short to search for
//! (it is one digit); the structural check instead refuses any request key
//! named `seed`, `salt`, `secret`, `private` or `journal`.

#[path = "ai_common.rs"]
mod common;

use common::*;
use fclient::Signer;
use frontier_agents::fixture::{FINAL, NOW, SEED};
use serde_json::{json, Value};

const BELL: i64 = 600;

fn forms(b: &[u8]) -> Vec<Vec<u8>> {
    let b64 = frontier_agents::obs::b64_encode(b);
    vec![
        b.to_vec(),
        hex::encode(b).into_bytes(),
        hex::encode_upper(b).into_bytes(),
        b64.into_bytes(),
    ]
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    needle.len() >= 8 && hay.windows(needle.len()).any(|w| w == needle)
}

fn keys_of(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                out.push(k.to_lowercase());
                keys_of(x, out);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| keys_of(x, out)),
        _ => {}
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_thousand_requests_contain_no_secret_seed_salt_plaintext_or_sealed_destination() {
    let fm = FakeMind::start(|req| {
        match (
            req["bell"].as_u64().unwrap() % 3 == 0,
            cand_id(req, "march"),
        ) {
            (true, Some(c)) => model_answer(
                &[&c],
                json!({c.clone(): {"stance": "assault", "retreat": 5000, "timing": "earliest"}}),
            ),
            _ => autopilot_answer("below_gate"),
        }
    })
    .await;
    let r = rig(Some(&fm), &[(FINAL, "ai")]);
    let mut bot = ai_bot();
    for k in 0..1000i64 {
        r.sh.clock.set(NOW + k * BELL);
        r.set_patch(Some(patch_resolved(40 + k as u32)));
        bot.step(&r.sh, true).await;
    }
    let reqs = fm.requests.lock().unwrap().clone();
    let outs = fm.outcomes.lock().unwrap().clone();
    assert!(
        reqs.len() >= 900,
        "{} requests (a step without a session or a home sends none)",
        reqs.len()
    );
    assert!(
        !bot.mem.marches.is_empty(),
        "marches were sent: salts exist"
    );
    // One 500-troop march a day fits the day cap (60 % of H0 = 600): 7 game days.
    assert!(
        r.hook.stat_of("model_marches_sent") >= 5,
        "{}",
        r.hook.stat_of("model_marches_sent")
    );

    // The forbidden strings.
    let mut forbidden: Vec<(String, Vec<u8>)> = vec![];
    for (name, kp) in [
        ("wallet", frontier_agents::keys::wallet(SEED, FINAL)),
        ("session", frontier_agents::keys::session(SEED, FINAL)),
        ("direct", frontier_agents::keys::direct(SEED, FINAL)),
    ] {
        for f in forms(kp.secret_bytes()) {
            forbidden.push((format!("{name} secret"), f));
        }
        for f in forms(&kp.to_bytes()) {
            forbidden.push((format!("{name} keypair"), f));
        }
        forbidden.push((
            format!("{name} keypair base58"),
            kp.to_base58_string().into_bytes(),
        ));
    }
    for f in forms(&SEED.to_le_bytes()) {
        forbidden.push(("seed (little-endian)".into(), f));
    }
    // 8-byte needles are the shortest searched; "0700000000000000" is 16 hex chars.
    for m in &bot.mem.marches {
        for (what, bytes) in [
            ("salt", &m.salt[..]),
            ("plain", &m.plain[..]),
            ("seal", &m.seal[..]),
        ] {
            for f in forms(bytes) {
                forbidden.push((format!("march {what}"), f));
            }
        }
    }
    let mut scanned = 0usize;
    let mut found_public_wallet = 0;
    for body in reqs.iter().chain(outs.iter()) {
        let text = serde_json::to_vec(body).unwrap();
        scanned += text.len();
        for (what, f) in &forbidden {
            assert!(!has(&text, f), "{what} appears in a request/outcome");
        }
        let mut ks = vec![];
        keys_of(body, &mut ks);
        for bad in [
            "seed", "salt", "secret", "private", "journal", "plain", "seal",
        ] {
            assert!(!ks.iter().any(|k| k == bad), "a key named {bad}");
        }
        // Positive control: the scan reads real content (the public wallet is there).
        if body.get("ai").is_some()
            && body["ai"]["wallet"].as_str()
                == Some(
                    &frontier_agents::keys::wallet(SEED, FINAL)
                        .pubkey()
                        .to_string(),
                )
        {
            found_public_wallet += 1;
        }
    }
    assert!(found_public_wallet >= 900);
    assert!(scanned > 1_000_000, "scanned {scanned} bytes");

    // A march in flight is never in a request: while it departed and has not
    // arrived, `own_marches[].opened` is null and no field of the entry names
    // its destination.
    let mut checked = 0;
    for body in &reqs {
        let bell = body["bell"].as_u64().unwrap() as u32;
        for om in body["own_marches"].as_array().unwrap() {
            if bell <= om["arrive_bell"].as_u64().unwrap() as u32 {
                assert_eq!(om["opened"], Value::Null);
                for k in om.as_object().unwrap().keys() {
                    assert!(
                        [
                            "host_id",
                            "troops_at_depart",
                            "depart_bell",
                            "arrive_bell",
                            "opened"
                        ]
                        .contains(&k.as_str()),
                        "{k}"
                    );
                }
                checked += 1;
            }
        }
    }
    assert!(
        checked >= 5,
        "in-flight own marches were listed {checked} times"
    );
}
