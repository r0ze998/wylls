//! Domain separation of the social signers (contract §6.1, Appendix A.5;
//! unit AC3b): `aisign.rs` signs only bytes that start with one of the three
//! live TAGs, refuses the reserved pact TAG by name, and no TAG-prefixed byte
//! string parses as a single-signer Solana transaction, so a signature the
//! session key gives a social record cannot be replayed as a transaction
//! signature (and the session key's transaction messages are never signed as
//! records). Byte 0 of every TAG is `w` = 0x77: as a legacy message header it
//! claims 119 required signatures, and as a v0 prefix it is not 0x80.

use fclient::tx::{self, TxBudget};
use fclient::{Address, Hash, Keypair, Signer};
use frontier_bots::ai::aisign::{
    self, Ballot, CallRead, RecordType, Talk, TalkTarget, BALLOT_TAG, CALLREAD_TAG, RESERVED_TAG,
    TALK_TAG,
};

fn key() -> Keypair {
    Keypair::new_from_array([0x51; 32])
}

fn sample_talk() -> Vec<u8> {
    aisign::encode_talk(&Talk {
        season: 31,
        bell: 402,
        wallet: [3; 32],
        seq: aisign::seq_of(402, 0).unwrap(),
        target: TalkTarget::Nation(2),
        kind: 0,
        reference: 0,
        origin: 1,
        lang: *b"en",
        text: "Good morning.".into(),
    })
    .unwrap()
}

fn sample_ballot() -> Vec<u8> {
    aisign::encode_ballot(&Ballot {
        season: 31,
        period: 5,
        wallet: [3; 32],
        faction: 4,
        option: 2,
        candidates_hash: [9; 32],
        nonce: [7; 16],
        origin: 1,
    })
    .unwrap()
}

fn sample_callread() -> Vec<u8> {
    aisign::encode_callread(&CallRead {
        season: 31,
        faction: 4,
        period: 5,
        wallet: [3; 32],
        unix: 1_800_000_000,
    })
}

/// A genuine one-signer transaction (a system transfer paid by `key()`).
fn genuine_tx() -> fclient::Transaction {
    let payer = key();
    let ix = tx::transfer(payer.pubkey(), Address::new_from_array([8; 32]), 5);
    let budget = TxBudget {
        cu_limit: 10_000,
        cu_price: 0,
        loaded_limit: 100_000,
        heap: None,
    };
    tx::build(&[ix], &budget, &[&payer], &Hash::new_from_array([6; 32])).unwrap()
}

/// `shortvec(1) ‖ signature ‖ bytes`: the wire form of a one-signature
/// transaction whose message is `bytes`.
fn as_one_signer_wire(bytes: &[u8], sig: &[u8; 64]) -> Vec<u8> {
    let mut w = vec![1u8];
    w.extend_from_slice(sig);
    w.extend_from_slice(bytes);
    w
}

#[test]
fn only_the_three_live_tags_are_signable() {
    assert_eq!(aisign::signable(&sample_talk()), Ok(RecordType::Talk));
    assert_eq!(aisign::signable(&sample_ballot()), Ok(RecordType::Ballot));
    assert_eq!(
        aisign::signable(&sample_callread()),
        Ok(RecordType::CallRead)
    );
    // Nothing else, whatever it looks like.
    for bytes in [
        vec![],
        b"wylls".to_vec(),
        b"wylls/frontier/talk/v2 and more".to_vec(),
        b"WYLLS/FRONTIER/TALK/V1".to_vec(),
        // One byte off the talk TAG.
        {
            let mut t = sample_talk();
            t[5] ^= 1;
            t
        },
        // A TAG that is only a prefix of a longer string.
        TALK_TAG[..TALK_TAG.len() - 1].to_vec(),
    ] {
        let e = aisign::signable(&bytes).expect_err("not signable");
        assert_eq!(e.code, "NotSignable", "{bytes:?}");
        assert!(aisign::sign_record(&bytes, &key()).is_err());
    }
}

#[test]
fn the_reserved_pact_tag_is_refused_by_name() {
    assert_eq!(RESERVED_TAG, b"wylls/frontier/pact/v1");
    let mut pact = RESERVED_TAG.to_vec();
    pact.extend_from_slice(&[1, 2, 3, 4]);
    assert!(aisign::is_reserved(&pact));
    let e = aisign::signable(&pact).unwrap_err();
    assert_eq!(
        (e.code, e.detail.as_str()),
        ("NotSignable", "the reserved TAG is refused")
    );
    assert!(aisign::sign_record(&pact, &key()).is_err());
    // Decoding refuses it too, and no live TAG is the pact TAG.
    assert!(aisign::decode(&pact).is_err());
    for tag in [TALK_TAG, BALLOT_TAG, CALLREAD_TAG] {
        assert!(!tag.starts_with(RESERVED_TAG) && !RESERVED_TAG.starts_with(tag));
    }
}

#[test]
fn a_transaction_message_is_never_signed_as_a_record() {
    let t = genuine_tx();
    let message = t.message_data();
    assert!(aisign::sign_record(&message, &key()).is_err());
    // Not even with a live TAG missing: the whole wire form is refused too.
    assert!(aisign::sign_record(&tx::wire(&t), &key()).is_err());
}

#[test]
fn a_record_signature_is_not_a_transaction_signature() {
    // The control: a genuine transaction parses and has one required signer.
    let t = genuine_tx();
    let parsed = tx::from_wire(&tx::wire(&t)).expect("a genuine transaction parses");
    assert_eq!(parsed.message.header.num_required_signatures, 1);
    assert_eq!(parsed.signatures.len(), 1);
    // A record, put where a message goes under one signature, is not a valid
    // single-signer transaction: either it does not parse, or its header
    // does not ask for exactly the one signature that is there.
    for bytes in [sample_talk(), sample_ballot(), sample_callread()] {
        assert_eq!(bytes[0], 0x77, "byte 0 of every TAG is 'w'");
        assert_eq!(bytes[0] & 0x80, 0, "not a v0 prefix");
        let signed = aisign::sign_record(&bytes, &key()).unwrap();
        let wire = as_one_signer_wire(&bytes, &signed.sig);
        match tx::from_wire(&wire) {
            Err(_) => {}
            Ok(p) => assert_ne!(
                p.message.header.num_required_signatures as usize,
                p.signatures.len(),
                "a record parsed as a valid single-signer transaction"
            ),
        }
        // The legacy header says 119 required signatures, never 1.
        assert_eq!(bytes[0], 119);
    }
}

#[test]
fn the_three_records_are_not_each_others() {
    let (t, b, c) = (sample_talk(), sample_ballot(), sample_callread());
    assert!(aisign::decode_ballot(&t).is_err() && aisign::decode_callread(&t).is_err());
    assert!(aisign::decode_talk(&b).is_err() && aisign::decode_callread(&b).is_err());
    assert!(aisign::decode_talk(&c).is_err() && aisign::decode_ballot(&c).is_err());
    // The same key signs each; the signatures differ because the bytes do.
    let (st, sb, sc) = (
        aisign::sign_record(&t, &key()).unwrap().sig,
        aisign::sign_record(&b, &key()).unwrap().sig,
        aisign::sign_record(&c, &key()).unwrap().sig,
    );
    assert!(st != sb && sb != sc && st != sc);
    // The signature is the session key's plain ed25519 signature of the bytes.
    assert_eq!(<[u8; 64]>::from(key().sign_message(&t)), st);
}
