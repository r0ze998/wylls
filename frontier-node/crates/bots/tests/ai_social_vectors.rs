//! Byte conformance of `bots/src/ai/aisign.rs` against the vectors of the
//! social layer (contract §6.1): `permutation-gateway/test/fixtures/
//! ai-social-v1.json`. **One producer** (`permutation-gateway/citizens/
//! social/vectors.mjs`, AC4) and **one freshness checker**
//! (`citizens-social.test.mjs`); this file checks conformance only: for every
//! vector the fields encode to `bytes_hex`, decode back, sign to `sig_hex`
//! (ed25519 is deterministic) and give `inner_hex` and `leaf_hex`, and every
//! refused case is refused with its code.
//!
//! The fixture on this branch is a byte copy of AC4's at `42eef66`
//! (sha256 c59969ef...); the integrator takes AC4's file at merge.

use fclient::{Keypair, Signer};
use frontier_bots::ai::aisign::{self, Ballot, CallRead, Record, RecordType};
use serde_json::Value;

fn fixture() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../permutation-gateway/test/fixtures/ai-social-v1.json");
    let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&text).expect("the vectors parse")
}

fn unhex(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("hex")
}

fn key_of(f: &Value, name: &str) -> Keypair {
    let k = f["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["name"] == name)
        .unwrap_or_else(|| panic!("key {name}"));
    let seed: [u8; 32] = unhex(&k["seed_hex"]).try_into().unwrap();
    let kp = Keypair::new_from_array(seed);
    assert_eq!(
        kp.pubkey().to_bytes().to_vec(),
        unhex(&k["wallet_hex"]),
        "the seed gives the vector's wallet"
    );
    assert_eq!(kp.pubkey().to_string(), k["wallet_b58"].as_str().unwrap());
    kp
}

#[test]
fn the_tags_are_the_pinned_strings() {
    let f = fixture();
    assert_eq!(f["v"], 1);
    assert_eq!(
        f["tags"]["talk"].as_str().unwrap().as_bytes(),
        aisign::TALK_TAG
    );
    assert_eq!(
        f["tags"]["ballot"].as_str().unwrap().as_bytes(),
        aisign::BALLOT_TAG
    );
    assert_eq!(
        f["tags"]["callread"].as_str().unwrap().as_bytes(),
        aisign::CALLREAD_TAG
    );
    assert_eq!(
        f["tags"]["reserved"].as_str().unwrap().as_bytes(),
        aisign::RESERVED_TAG
    );
    assert_eq!(aisign::TALK_TAG.len(), 22);
    assert_eq!(aisign::BALLOT_TAG.len(), 24);
    assert_eq!(aisign::CALLREAD_TAG.len(), 26);
}

/// Encodes, decodes, signs and hashes one vector; returns the bytes.
fn check_signed(f: &Value, v: &Value, bytes: &[u8]) {
    assert_eq!(
        hex::encode(bytes),
        v["bytes_hex"].as_str().unwrap(),
        "{}",
        v["name"]
    );
    let signer = key_of(f, v["signer"].as_str().unwrap());
    let signed = aisign::sign_record(bytes, &signer).expect("signable");
    assert_eq!(signed.bytes, bytes);
    assert_eq!(
        hex::encode(signed.sig),
        v["sig_hex"].as_str().unwrap(),
        "{}",
        v["name"]
    );
    if let Some(inner) = v.get("inner_hex") {
        assert_eq!(hex::encode(signed.inner()), inner.as_str().unwrap());
        assert_eq!(
            hex::encode(aisign::leaf_of(&signed.inner())),
            v["leaf_hex"].as_str().unwrap()
        );
    }
}

#[test]
fn every_talk_vector_encodes_decodes_and_signs_to_the_pinned_bytes() {
    let f = fixture();
    let talk = f["talk"].as_array().unwrap();
    assert!(
        talk.len() >= 6,
        "world, nation, direct, motion, seat, 280 emoji"
    );
    for v in talk {
        let fields = &v["fields"];
        let wallet = aisign::key32(fields["wallet"].as_str().unwrap()).unwrap();
        let t =
            aisign::talk_from_json(fields, wallet).unwrap_or_else(|e| panic!("{}: {e}", v["name"]));
        let bytes = aisign::encode_talk(&t).expect("encodes");
        check_signed(&f, v, &bytes);
        assert_eq!(aisign::decode_talk(&bytes).unwrap(), t, "{}", v["name"]);
        assert!(matches!(aisign::decode(&bytes), Ok(Record::Talk(_))));
        assert_eq!(aisign::record_type(&bytes), Some(RecordType::Talk));
    }
}

#[test]
fn every_ballot_vector_encodes_decodes_and_signs_to_the_pinned_bytes() {
    let f = fixture();
    let ballots = f["ballot"].as_array().unwrap();
    assert_eq!(ballots.len(), 3);
    for v in ballots {
        let fields = &v["fields"];
        let wallet = aisign::key32(fields["wallet"].as_str().unwrap()).unwrap();
        let b: Ballot = aisign::ballot_from_json(fields, wallet).expect("fields");
        assert_eq!(
            hex::encode(b.candidates_hash),
            f["candidates_hash_hex"].as_str().unwrap()
        );
        assert_eq!(hex::encode(b.nonce), f["nonce_hex"].as_str().unwrap());
        let bytes = aisign::encode_ballot(&b).expect("encodes");
        check_signed(&f, v, &bytes);
        assert_eq!(aisign::decode_ballot(&bytes).unwrap(), b);
        assert_eq!(aisign::record_type(&bytes), Some(RecordType::Ballot));
    }
}

#[test]
fn every_call_read_vector_encodes_decodes_and_signs_to_the_pinned_bytes() {
    let f = fixture();
    let reads = f["callread"].as_array().unwrap();
    assert_eq!(reads.len(), 2);
    for v in reads {
        let x = &v["fields"];
        let r = CallRead {
            season: x["season"].as_str().unwrap().parse().unwrap(),
            faction: x["faction"].as_u64().unwrap() as u8,
            period: x["period"].as_u64().unwrap() as u32,
            wallet: aisign::key32(x["wallet"].as_str().unwrap()).unwrap(),
            unix: x["unix"].as_str().unwrap().parse().unwrap(),
        };
        let bytes = aisign::encode_callread(&r);
        check_signed(&f, v, &bytes);
        assert_eq!(aisign::decode_callread(&bytes).unwrap(), r);
        assert_eq!(aisign::record_type(&bytes), Some(RecordType::CallRead));
        // The query a member read sends: the signature percent-encoded.
        let signer = key_of(&f, v["signer"].as_str().unwrap());
        let signed = aisign::sign_record(&bytes, &signer).unwrap();
        let q = aisign::callread_query(&r, &signed);
        assert!(q.starts_with(&format!(
            "faction={}&period={}&wallet=",
            r.faction, r.period
        )));
        let sig_part = q.rsplit("sig=").next().unwrap();
        assert!(
            sig_part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'%'),
            "{sig_part}"
        );
    }
}

#[test]
fn every_refused_vector_is_refused_with_its_code() {
    let f = fixture();
    let refused = f["refused"].as_array().unwrap();
    assert!(refused.len() >= 7);
    for v in refused {
        let bytes = unhex(&v["bytes_hex"]);
        let name = v["name"].as_str().unwrap();
        let e = aisign::decode(&bytes).expect_err(name);
        assert_eq!(e.code, v["code"].as_str().unwrap(), "{name}: {e}");
        assert_eq!(
            aisign::signable(&bytes).is_ok(),
            v["signable"].as_bool().unwrap(),
            "{name}: the guard only checks the TAG"
        );
    }
}

#[test]
fn sha256_matches_the_vectors() {
    let f = fixture();
    for v in f["sha256"].as_array().unwrap() {
        let input = v["input_utf8"].as_str().unwrap();
        assert_eq!(
            hex::encode(aisign::sha256(&[input.as_bytes()])),
            v["sha256_hex"].as_str().unwrap()
        );
    }
}

#[test]
fn the_seq_and_motion_rules_match_the_producer() {
    // vectors.mjs: seqOf(402, 0) = 6432, motionRef(5, 2) = 1282.
    assert_eq!(aisign::seq_of(402, 0).unwrap(), 6432);
    assert_eq!(aisign::seq_of(9999, 15).unwrap(), 159_999);
    assert_eq!(aisign::motion_ref(5, 2), 1282);
}
