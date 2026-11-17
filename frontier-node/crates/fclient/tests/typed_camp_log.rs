//! Scoped literal camp-v2 observations; no keys, signing, runtime or network.
#![cfg(feature = "wide-records-experimental")]
#[path = "fixtures/camp_observation.rs"]
mod fixture;
use fclient::typed_log::*;
use frontier_abi::world_index::expedition_settlement_event as settlement;

#[test]
fn camp_pair_preserves_version_and_citizen_and_recomputes_v2_chain() {
    let c = fixture::ctx();
    let p = fclient::Address::new_from_array(c.program);
    let (a, b, link) = fixture::pair(fixture::zero());
    let tx = fixture::tx(1, &[(b"PS2", &a), (b"PSW1", &b)]);
    assert!(decode_transaction(&tx, &p).is_err());
    assert!(decode_transaction_with_resident(&tx, &p, &c).is_err());
    let TransactionRecords::Committed(records) =
        decode_transaction_with_expedition(&tx, &p, &c).unwrap()
    else {
        panic!()
    };
    assert_eq!(records.len(), 2);
    for (record, body) in records.iter().zip([&a, &b]) {
        assert_eq!(record.body(), body);
        assert!(settlement::Record::decode(&c, body).is_err());
        let decoded = record.expedition(&c).unwrap().unwrap();
        let ExpeditionRecord::CampSettlement(camp) = &decoded else {
            panic!()
        };
        assert_eq!(camp.record.identity.citizen, Some([7; 32]));
        assert_eq!(decoded.province(), fixture::province());
        assert_eq!(decoded.host(), Some(camp.record.identity.host));
        if camp.record.wide_link.is_some() {
            assert_eq!(decoded.settlement_wide_link(), Some(link));
            decoded
                .verify_settlement_wide_previous(&c, fixture::zero())
                .unwrap();
            assert!(camp
                .record
                .verify_previous(&c, &[], Some(fixture::zero()))
                .is_err());
            assert!(decoded.verify_settlement_wide_previous(&c, link).is_err());
        } else {
            assert_eq!(camp.record.original_links.len(), 2);
            assert!(decoded.settlement_wide_link().is_none());
        }
    }
}

#[test]
fn camp_pair_rejects_orphans_duplicates_scope_version_identity_and_domain_changes() {
    let c = fixture::ctx();
    let p = fclient::Address::new_from_array(c.program);
    let (a, b, _) = fixture::pair(fixture::zero());
    for parts in [
        vec![(b"PS2".as_slice(), a.as_slice())],
        vec![(b"PSW1".as_slice(), b.as_slice())],
        vec![
            (b"PS2".as_slice(), a.as_slice()),
            (b"PSW1", b.as_slice()),
            (b"PS2", a.as_slice()),
        ],
        vec![(b"PSW1".as_slice(), a.as_slice()), (b"PS2", b.as_slice())],
    ] {
        assert!(decode_transaction_with_expedition(&fixture::tx(1, &parts), &p, &c).is_err());
    }
    for i in [6, 7, 9, 10, 326, 358, 390, 422] {
        let mut bad = a.clone();
        bad[i] ^= 1;
        assert!(
            decode_transaction_with_expedition(
                &fixture::tx(1, &[(b"PS2", &bad), (b"PSW1", &b)]),
                &p,
                &c
            )
            .is_err(),
            "offset {i}"
        );
    }
    let tx = fixture::tx(1, &[(b"PS2", &a), (b"PSW1", &b)]);
    // A separately well-formed member-v1 half cannot complete a camp-v2 pair.
    let mut member = b.clone();
    member[6] = settlement::VERSION;
    member[358..390].copy_from_slice(&settlement::Receipt::new([1; 32], [2; 32]).operation_id);
    assert!(settlement::Record::decode(&c, &member).is_ok());
    assert!(decode_transaction_with_expedition(
        &fixture::tx(1, &[(b"PS2", &a), (b"PSW1", &member)]),
        &p,
        &c
    )
    .is_err());
    let mut wrong = c;
    wrong.season[0] ^= 1;
    assert!(decode_transaction_with_expedition(&tx, &p, &wrong).is_err());
    let mut failed = tx;
    failed.err = Some("rolled back".into());
    assert_eq!(
        decode_transaction_with_expedition(&failed, &p, &c).unwrap(),
        TransactionRecords::RolledBack
    );
}
