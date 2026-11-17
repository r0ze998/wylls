//! WRITTEN, NOT RUN (2026-11-17, under an execution pause): this file has not
//! been compiled or run. Run it only with its own approval.
//!
//! `me_from_answer` (bot.rs): only the herald's 404 is "not joined"; a failed
//! `/h/me` read or a body that is not the view is an error, so no decision is
//! made on an empty view the herald never gave (a joined bot deciding `Join`
//! again in the join window).
//!   M1 404 → the empty view (no Citizen, no holdings, no quota)
//!   M2 200 with a view → that view (here: no Citizen, quota 38)
//!   M3 a transport failure or a status other than 200/404 → an error naming /h/me
//!   M4 200 with a body that is not JSON, or JSON that is not the view → an error
//!   M5 the source: observe reads /h/me through me_from_answer, not json_of
//!
//! Plain bytes only: no key is generated, derived or used; nothing is signed,
//! sent, spawned or fetched.

use fclient::ports::PortError;
use fclient::Address;
use frontier_bots::bot::me_from_answer;
use serde_json::json;

const WALLET: &str = "11111111111111111111111111111111";

fn wallet() -> Address {
    WALLET.parse().expect("an address")
}

#[test]
fn m1_404_is_not_joined() {
    let me = me_from_answer(wallet(), Ok(None)).expect("the empty view");
    assert!(me.citizen.is_none() && me.holdings.is_empty() && me.quota_left.is_none());
}

#[test]
fn m2_a_view_is_read() {
    let body = json!({
        "v": 1,
        "wallet": WALLET,
        "citizen": null,
        "holdings": [],
        "quota": {"left": 38},
    });
    let me = me_from_answer(wallet(), Ok(Some(serde_json::to_vec(&body).unwrap())))
        .expect("a view");
    assert_eq!(me.quota_left, Some(38));
    assert!(me.citizen.is_none());
}

#[test]
fn m3_a_failed_read_is_an_error() {
    for e in [
        PortError::Http(503),
        PortError::Http(500),
        PortError::Io("connection refused".into()),
    ] {
        let r = me_from_answer(wallet(), Err(e));
        let msg = r.expect_err("never the empty view");
        assert!(msg.starts_with("/h/me: "), "{msg}");
    }
}

#[test]
fn m4_a_body_that_is_not_the_view_is_an_error() {
    let bodies: [&[u8]; 4] = [
        b"",
        b"<html>bad gateway</html>",
        br#"{"v": 2, "wallet": "11111111111111111111111111111111"}"#,
        b"null",
    ];
    for b in bodies {
        let r = me_from_answer(wallet(), Ok(Some(b.to_vec())));
        assert!(r.is_err(), "{:?}", String::from_utf8_lossy(b));
    }
}

#[test]
fn m5_observe_reads_me_through_it() {
    let src = include_str!("../src/bot.rs");
    let at = src.find("pub async fn observe<").expect("observe");
    let body = src[at..].split("let mut overviews").next().expect("the reads");
    assert!(body.contains("me_from_answer(wallet, sh.herald.get(&me_path).await)?"), "{body}");
    assert!(!body.contains("json_of(&sh.herald, &format!(\"/h/me/"), "{body}");
}
