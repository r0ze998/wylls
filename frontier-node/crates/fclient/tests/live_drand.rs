//! Live quicknet over HTTPS, a round in the future (`#[ignore]`; run with
//! `FRONTIER_LIVE_DRAND=1 cargo test -p fclient --test live_drand -- --ignored --nocapture`).
//!
//! 1. The endpoints serve the pinned quicknet chain (`discover_pinned`);
//!    the bare `/info` of api.drand.sh (another network) and the test key's
//!    chain are refused.
//! 2. A future round `R` is picked from the live `latest`; a season clock
//!    is laid so that `T(arrive) = R`, and a march is sealed to `R` twice:
//!    with `fclient::seal` (the keeper/bots/verifier crate, stock tlock)
//!    and with the browser's own modules under node (`seal.mjs`
//!    `sealMarch`, the pinned `checkBeacon`).
//! 3. Before `R` is published: `HttpDrand` answers "not yet" (425 on every
//!    endpoint); neither seal opens with the newest published signature,
//!    with the test key's signature of `R`, or with a flipped one; the
//!    plaintext is not in the seal.
//! 4. After: `R` is fetched over HTTPS and verified; both seals open, in
//!    both implementations, to their plaintexts; the verifier's judgement
//!    (`seal::judge`, the one V5 uses) is code 0; the hash-to-curve hints
//!    the program checks are RFC 9380's for `R`.
//!
//! What this does not show: the on-chain SettleTransit (no SBF toolchain
//! here), nor anything about tlock's security beyond these cases.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fclient::beacon::{self, HttpDrand, TestKey};
use fclient::clock::Drand;
use fclient::ports::DrandPort;
use fclient::seal::{self, Plain};

const DEFAULT_URLS: [&str; 4] = [
    "https://api.drand.sh",
    "https://api2.drand.sh",
    "https://api3.drand.sh",
    "https://drand.cloudflare.com",
];

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn log(s: impl AsRef<str>) {
    eprintln!("[{}] {}", now(), s.as_ref());
}

fn node(args: &[&str]) -> serde_json::Value {
    let js = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/live_js_seal.mjs");
    let out = std::process::Command::new("node")
        .arg(js)
        .args(args)
        .output()
        .expect("node is needed for the browser half");
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| {
        panic!(
            "node: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

fn h(s: &serde_json::Value) -> Vec<u8> {
    hex::decode(s.as_str().unwrap()).unwrap()
}

#[tokio::test]
#[ignore = "live: contacts public drand over https; set FRONTIER_LIVE_DRAND=1"]
async fn a_future_quicknet_round_seals_refuses_then_opens() {
    assert_eq!(
        std::env::var("FRONTIER_LIVE_DRAND").as_deref(),
        Ok("1"),
        "NOT RUN: set FRONTIER_LIVE_DRAND=1 (this test reads public drand)"
    );
    let urls: Vec<String> = std::env::var("FRONTIER_LIVE_DRAND_URLS")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| DEFAULT_URLS.iter().map(|s| s.to_string()).collect());
    let lead: u64 = std::env::var("FRONTIER_LIVE_LEAD_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);

    // 1. The pinned chain, and nothing else.
    let q = beacon::quicknet_info();
    let pins = beacon::pins_for(&urls);
    assert_eq!(pins, vec![q.clone()], "no test key off loopback");
    let info = beacon::discover_pinned(&urls, &pins).await.expect("quicknet served");
    assert_eq!(info, q);
    log(format!("pinned chain {} served by {urls:?}", hex::encode(info.chain_hash)));
    let bare = fclient::http::get(&format!("{}/info", urls[0])).await.unwrap();
    let other = beacon::parse_info_json(&serde_json::from_slice(&bare.body).unwrap());
    match other {
        Some(o) => {
            let e = beacon::pin_info(&o, &q).unwrap_err();
            log(format!("bare /info is another network, refused: {e}"));
        }
        None => log("bare /info did not parse as chain info: refused"),
    }
    let e = beacon::discover_pinned(&urls[..1], &[TestKey::new().info()])
        .await
        .unwrap_err();
    log(format!("test-key chain on public drand refused: {e}"));

    // 2. A future round and a clock with T(arrive) = R.
    let latest = fclient::http::get(&format!(
        "{}/{}/public/latest",
        urls[0],
        hex::encode(q.chain_hash)
    ))
    .await
    .unwrap();
    let lv: serde_json::Value = serde_json::from_slice(&latest.body).unwrap();
    let l = lv["round"].as_u64().unwrap();
    let lb = beacon::check_served(&lv, l, &q.public_key).expect("latest verifies");
    let r = l + lead;
    let drand = Drand::QUICKNET;
    let arrive: u32 = 3;
    let genesis_ts = drand.round_time(r) - 600 * (arrive as i64 + 1);
    assert_eq!(drand.tlock_round(genesis_ts, arrive), r, "T(arrive) = R");
    log(format!(
        "latest {l} (round_time {}, local now {}); R = {r} at {}",
        q.round_time(l),
        now(),
        q.round_time(r)
    ));
    assert!(q.round_time(r) > now(), "R is in the future");

    let host = 0x5eed_0001_u64;
    let plain = Plain {
        version: 1,
        host_id: host,
        arrive_bell: arrive,
        dest_p: -3,
        dest_q: 7,
        dest_tile: 30,
        stance: 2,
        retreat_bps: 0,
        path_len: 2,
        path: seal::path_of(&[1, 4]),
        reserved: [0; 3],
    };
    let pt = seal::pack(&plain);
    let rs = seal::seal(&pt, &q.public_key, r).unwrap();
    let js = node(&["seal", &genesis_ts.to_string(), &arrive.to_string(), &host.to_string()]);
    assert_eq!(js["ok"], true, "{js}");
    assert_eq!(js["round"].as_u64(), Some(r), "the page seals to T(arrive) = R");
    let js_seal: [u8; seal::SEAL_LEN] = h(&js["seal"]).try_into().unwrap();
    let js_commit: [u8; 32] = h(&js["commit"]).try_into().unwrap();
    let js_plain = h(&js["plain"]);
    log(format!(
        "sealed to R: rust {}…, browser {}…",
        &hex::encode(rs.seal)[..16],
        &hex::encode(js_seal)[..16]
    ));

    // 3. Before publication.
    let d = HttpDrand::new(urls.clone(), q.clone());
    assert!(q.round_time(r) > now(), "still before R");
    assert_eq!(d.round(r).await, Ok(None), "every endpoint: not yet");
    log("HttpDrand(R) before publication: not yet (425)");
    let mut flipped = TestKey::new().sign(r);
    flipped[3] ^= 1;
    for (what, sig) in [
        ("newest published signature", lb.sig48),
        ("test key's signature of R", TestKey::new().sign(r)),
        ("a corrupted signature", flipped),
    ] {
        let (code, p) = seal::judge(&rs.seal, &rs.commit, &sig, host, arrive);
        assert!(code != 0 && p.is_none(), "rust seal, {what}: code {code}");
        let (code, p) = seal::judge(&js_seal, &js_commit, &sig, host, arrive);
        assert!(code != 0 && p.is_none(), "browser seal, {what}: code {code}");
        let o = node(&["open", &hex::encode(js_seal), &hex::encode(sig)]);
        assert_eq!(o["ok"], false, "browser opener, {what}: {o}");
        log(format!("before R, {what}: rust code {code}, browser {}", o["code"]));
    }
    for s in [&rs.seal[..], &js_seal[..]] {
        assert!(!s.windows(pt.len()).any(|w| w == pt), "plaintext not in the seal");
        assert!(!s.windows(8).any(|w| w == host.to_le_bytes()), "host id not in clear");
    }
    assert!(q.round_time(r) > now(), "all of step 3 ran before R");

    // 4. After publication.
    let wait = (q.round_time(r) - now()).max(0) as u64;
    log(format!("waiting {wait} s for R"));
    tokio::time::sleep(Duration::from_secs(wait)).await;
    let mut got = None;
    for i in 0..60 {
        match d.round(r).await {
            Ok(Some(b)) => {
                log(format!("R published, fetched after {i} retries: {}", hex::encode(b.sig48)));
                got = Some(b);
                break;
            }
            Ok(None) => {}
            Err(e) => log(format!("retry {i}: {e}")),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let b = got.expect("R published within 60 s of its time");
    assert!(beacon::verify(r, &b.sig48, &q.public_key));
    let (code, p) = seal::judge(&rs.seal, &rs.commit, &b.sig48, host, arrive);
    assert_eq!((code, p), (0, Some(plain)), "rust seal opens");
    let (code, p) = seal::judge(&js_seal, &js_commit, &b.sig48, host, arrive);
    assert_eq!(code, 0, "browser seal opens with the stock opener");
    assert_eq!(seal::pack(&p.unwrap()).to_vec(), js_plain);
    let o = node(&["open", &hex::encode(rs.seal), &hex::encode(b.sig48)]);
    assert_eq!(o["ok"], true, "{o}");
    assert_eq!(h(&o["plain"]), pt.to_vec(), "browser opener opens the rust seal");
    assert_eq!(h(&o["commit"]), rs.commit.to_vec());
    assert_eq!(
        beacon::hash_be(r),
        beacon::hash_blstrs_be(r),
        "the program's hinted map = RFC 9380 for R"
    );
    assert_eq!(beacon::hints_bytes(r).len(), fclient::ix::HINTS_LEN);
    log("after R: both seals open in both implementations; judge code 0");
}
