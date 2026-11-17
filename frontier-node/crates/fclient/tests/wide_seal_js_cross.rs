//! Rust ⇄ browser cross-check of the 264-byte wide seal over the PUBLISHED
//! Quicknet round of `fixtures/tlock/q4-vector.json` (consistency only,
//! never future secrecy). The shared vector file
//! `permutation-gateway/test/fixtures/wide-seal-cross-v1.json` holds one seal
//! made by `fclient::wide_seal::seal_wide` (Rust) and one made by
//! `web/frontier/seal-wide.mjs` (browser), each to the same plaintext; each
//! side opens the other's with the real round signature. No key, salt or
//! k is in the file (public seal, commitment and plaintext only).
#![cfg(feature = "wide-records-experimental")]

use fclient::wide_seal::{open_wide, seal_wide};
use frontier_abi::world_index::key::WideHostRef;
use frontier_abi::world_index::seal::{self as ws, WidePlain, WIDE_SEAL_LEN};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WorldId};
use permutation_rules::frontier::seal as ks;
use serde_json::Value;

const CROSS: &str =
    include_str!("../../../../permutation-gateway/test/fixtures/wide-seal-cross-v1.json");

fn key(p: i64, q: i64) -> ProvinceKey {
    ProvinceKey::new(
        WorldId::new([0x77; 32]).unwrap(),
        WideCoord::checked(p, q).unwrap(),
    )
}
fn host() -> WideHostRef {
    WideHostRef::new(key(128, 0), 3, 1, 7).unwrap()
}
fn plain() -> WidePlain {
    let (path_len, path) = ks::encode_path(&[0]).unwrap();
    WidePlain {
        version: ws::WIDE_PLAIN_VERSION,
        host: host(),
        arrive_bell: 500,
        dest: key(129, 0),
        dest_tile: 4,
        stance: 2,
        retreat_bps: 0,
        path_len,
        path,
        reserved: [0; ws::WIDE_RESERVED_BYTES],
    }
}
fn q4() -> (u64, [u8; 48], [u8; 48]) {
    let v: Value = serde_json::from_str(
        &std::fs::read_to_string(fclient::seal::fixture_dir().join("q4-vector.json")).unwrap(),
    )
    .unwrap();
    let hx = |k: &str| hex::decode(v[k].as_str().unwrap()).unwrap();
    (
        v["round"].as_u64().unwrap(),
        hx("sig").try_into().unwrap(),
        hx("prev_round_sig").try_into().unwrap(),
    )
}
fn arr<const N: usize>(v: &Value) -> [u8; N] {
    hex::decode(v.as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap()
}

/// Prints this side's vector (run once with `--ignored --nocapture` to
/// refresh the shared file's `rust` section and `plain`).
#[test]
#[ignore]
fn emit_rust_wide_seal_vector() {
    let (round, _, _) = q4();
    let pk = fclient::beacon::quicknet_info().public_key;
    let s = seal_wide(&plain(), &host(), 500, &pk, round).unwrap();
    println!(
        "{}",
        serde_json::json!({"round": round, "host": hex::encode(host().to_bytes()), "arriveBell": 500,
            "plain": hex::encode(ws::pack(&plain())),
            "rust": {"seal": hex::encode(s.seal), "commit": hex::encode(s.commit), "ctHash": hex::encode(s.ct_hash), "sealRoot": hex::encode(s.seal_root)}})
    );
}

#[test]
fn rust_opens_the_browser_seal_and_both_agree_on_the_plaintext() {
    let v: Value = serde_json::from_str(CROSS).unwrap();
    let (round, sig, prev) = q4();
    assert_eq!(v["round"].as_u64(), Some(round));
    assert_eq!(v["host"].as_str().unwrap(), hex::encode(host().to_bytes()));
    assert_eq!(
        v["plain"].as_str().unwrap(),
        hex::encode(ws::pack(&plain())),
        "the browser's packed plaintext is Rust's"
    );
    for side in ["rust", "js"] {
        let seal: [u8; WIDE_SEAL_LEN] = arr(&v[side]["seal"]);
        let commit: [u8; 32] = arr(&v[side]["commit"]);
        assert_eq!(
            open_wide(&seal, &sig, &commit, &host(), 500),
            Ok(plain()),
            "{side}"
        );
        assert_eq!(
            hex::encode(ws::ct_hash(&seal)),
            v[side]["ctHash"].as_str().unwrap(),
            "{side}"
        );
        assert_eq!(
            hex::encode(ws::seal_root(&commit, &ws::ct_hash(&seal))),
            v[side]["sealRoot"].as_str().unwrap(),
            "{side}"
        );
        // another round's real signature does not open it
        assert!(
            open_wide(&seal, &prev, &commit, &host(), 500).is_err(),
            "{side}"
        );
    }
    assert_ne!(v["rust"]["seal"], v["js"]["seal"], "independent fresh keys");
}
