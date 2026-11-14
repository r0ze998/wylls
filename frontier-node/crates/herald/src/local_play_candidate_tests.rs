//! The LOCAL TEST CANDIDATE lane's exact pair in the local-play bootstrap's metadata check: the conquest lane exactly
//! as before, the candidate only as [0x4C; 32] / 0xC804 / its lane word, and every mix refused.
use super::*;

const RPC: &str = "http://127.0.0.1:41980";
const SID: u64 = 11;
fn a(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn meta(program: [u8; 32], version: &str, lane: Option<Value>) -> Value {
    let mut m = json!({"schema": METADATA_SCHEMA, "rpc_url": RPC, "program": Address::new_from_array(program).to_string(),
        "program_version": version, "season_id": SID, "season": a(1).to_string(), "player_wallet": a(2).to_string(),
        "accounts": {"citizen": a(3).to_string(), "holding": a(4).to_string(), "home_province": a(5).to_string(),
            "frontier": a(6).to_string(), "ring_seed": a(7).to_string()},
        "artifact": {"sha256": "ab".repeat(32), "bytes": 3_613_280}});
    if let Some(l) = lane {
        m["lane_candidate"] = l;
    }
    m
}
fn check(program: [u8; 32], version: &str, lane: Option<Value>) -> Result<Expected, String> {
    expected(&meta(program, version, lane).to_string(), &Address::new_from_array(program), SID, RPC)
}

#[test]
fn the_two_lanes_are_exact_pairs() {
    assert!(check(PROGRAM, "0x4804", None).is_ok(), "the conquest lane, as before");
    assert!(check(CANDIDATE_PROGRAM, "0xc804", Some(json!(CANDIDATE_LANE))).is_ok(), "the candidate with its own version and lane word");
    assert_eq!(lane_version(&Address::new_from_array(PROGRAM)), Some(0x4804));
    assert_eq!(lane_version(&Address::new_from_array(CANDIDATE_PROGRAM)), Some(0xC804));
    assert_eq!(lane_version(&a(0x44)), None);
}

#[test]
fn every_mix_is_refused() {
    let cand = Some(json!(CANDIDATE_LANE));
    for (program, version, lane, why) in [
        (CANDIDATE_PROGRAM, "0x4804", cand.clone(), "the candidate id with the conquest version"),
        (PROGRAM, "0xc804", None, "the conquest id with the candidate version"),
        (PROGRAM, "0x4804", cand.clone(), "the conquest id with the candidate's lane word"),
        (PROGRAM, "0xc804", cand.clone(), "the conquest id with the candidate's version and lane word"),
        (CANDIDATE_PROGRAM, "0xc804", None, "the candidate without its lane word"),
        (CANDIDATE_PROGRAM, "0xc804", Some(json!("localnet-nft-sbf")), "the candidate with another lane word"),
        (CANDIDATE_PROGRAM, "0xc804", Some(json!(true)), "a lane word that is not a word"),
        (CANDIDATE_PROGRAM, "0x8004", cand.clone(), "the candidate with the NFT lane's version"),
        ([0x4E; 32], "0x8004", None, "the local NFT lane's id"),
        ([0x44; 32], "0x4804", None, "another program"),
    ] {
        assert!(check(program, version, lane).is_err(), "{why}");
    }
    // and the herald's own --program must be the metadata's
    let m = meta(CANDIDATE_PROGRAM, "0xc804", cand);
    assert!(expected(&m.to_string(), &Address::new_from_array(PROGRAM), SID, RPC).is_err());
}
