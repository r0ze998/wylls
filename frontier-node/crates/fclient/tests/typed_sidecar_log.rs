//! Public literal bytes only; no signing, private derivation or transactions.
#![cfg(feature = "wide-records-experimental")]
use base64::Engine;
use fclient::{
    ports::{Signature, TxRecord},
    typed_log::{self, DecodeError, ProgramRecord, TransactionRecords},
    Address,
};
use frontier_abi::world_index::event::conquest as c;

fn sidecar() -> Vec<u8> {
    c::SidecarClose {
        season: [24; 32],
        citizen: [25; 32],
        bell: 9,
        receipt: c::Receipt::new(c::ESCROW_CLOSE, 0, [1; 32], [2; 32]).unwrap(),
    }
    .encode()
    .unwrap()
    .to_vec()
}
fn line(body: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b.encode(b"PSWC"), b.encode(body))
}
fn tx(logs: Vec<String>) -> TxRecord {
    TxRecord {
        seq: 1,
        slot: 101,
        signature: Signature::from([3; 64]),
        block_time: 0,
        tx: vec![],
        logs,
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
#[test]
fn sidecar_format_is_preserved_and_never_a_wide_chain_record() {
    let p = Address::new_from_array([23; 32]);
    let body = sidecar();
    let t = tx(fclient::log::in_frame(&p, [line(&body)]));
    let TransactionRecords::Committed(records) = typed_log::decode_transaction(&t, &p).unwrap()
    else {
        panic!("committed")
    };
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].format(), "PSWC");
    assert_eq!(records[0].body(), body);
    assert!(records[0].wide().unwrap().is_none());
    assert_eq!(records[0].sidecar().unwrap().unwrap().citizen, [25; 32]);
    assert!(matches!(
        ProgramRecord::Pswc { body: vec![1] }.wide(),
        Err(DecodeError::Pswc(_))
    ));
}
#[test]
fn sidecar_malformed_unknown_failed_foreign_and_incomplete_frames_are_fail_closed() {
    let p = Address::new_from_array([23; 32]);
    let q = Address::new_from_array([26; 32]);
    let mut bad = sidecar();
    bad[0] = 2;
    for body in [bad, vec![1], {
        let mut b = sidecar();
        b[70] = c::FAILED;
        b
    }] {
        let mut t = tx(fclient::log::in_frame(&p, [line(&body)]));
        assert!(matches!(
            typed_log::decode_transaction(&t, &p),
            Err(DecodeError::Pswc(_))
        ));
        t.err = Some("rollback".into());
        assert_eq!(
            typed_log::decode_transaction(&t, &p),
            Ok(TransactionRecords::RolledBack)
        );
    }
    let t = tx(vec![
        format!("Program {q} invoke [1]"),
        format!("Program {p} invoke [2]"),
        line(&[1]),
        format!("Program {p} failed: caught"),
        format!("Program {q} success"),
    ]);
    assert_eq!(
        typed_log::decode_transaction(&t, &p),
        Ok(TransactionRecords::Committed(vec![]))
    );
    let t = tx(vec![
        format!("Program {p} invoke [1]"),
        format!("Program {q} invoke [2]"),
        line(&sidecar()),
        format!("Program {q} success"),
        format!("Program {p} success"),
    ]);
    assert_eq!(
        typed_log::decode_transaction(&t, &p),
        Ok(TransactionRecords::Committed(vec![]))
    );
    let t = tx(vec![format!("Program {p} invoke [1]"), line(&sidecar())]);
    assert!(typed_log::decode_transaction(&t, &p).is_err());
}
