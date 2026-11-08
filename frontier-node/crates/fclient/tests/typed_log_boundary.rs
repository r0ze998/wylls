//! Literal logs/public identities only. No keys, signing, chain or network.
#![cfg(feature = "wide-records-experimental")]
use base64::Engine;
use fclient::{
    ports::{Signature, TxRecord},
    typed_log::{decode_transaction, DecodeError, ProgramRecord, TransactionRecords},
    Address,
};
use frontier_abi::world_index::{event as e, ProvinceKey, WideCoord, WorldId};

fn program() -> Address {
    Address::new_from_array([23; 32])
}
fn other() -> Address {
    Address::new_from_array([24; 32])
}
fn line(tag: &[u8], body: &[u8]) -> String {
    let b = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b.encode(tag), b.encode(body))
}
fn ps2() -> Vec<u8> {
    let mut body = vec![0; 512];
    let k = frontier_abi::log::Kind::ANCHOR;
    let n = frontier_abi::log::write_body(k, 7, &[0; 5], &[0; 56], &mut body).unwrap();
    let n = frontier_abi::log::write_tail(&[], &mut body, n).unwrap();
    body.truncate(n);
    body
}
fn psw1() -> Vec<u8> {
    let key = ProvinceKey::new(
        WorldId::new([7; 32]).unwrap(),
        WideCoord::checked(9_007_199_254_740_993, 0).unwrap(),
    );
    e::encode(
        e::WideKind::RecordClosed,
        7,
        &key.to_bytes(),
        &e::record_closed_payload(2, 6, 1, 0, &[8; 32], 99),
        &[],
    )
    .unwrap()
}
fn tx(logs: Vec<String>) -> TxRecord {
    TxRecord {
        seq: 1,
        slot: 4,
        signature: Signature::from([1; 64]),
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
fn framed(lines: Vec<String>) -> TxRecord {
    tx(fclient::log::in_frame(&program(), lines))
}
#[test]
fn mixed_records_are_typed_exact_and_legacy_remains_blocked() {
    let old = ps2();
    let wide = psw1();
    let t = framed(vec![line(b"PS2", &old), line(b"PSW1", &wide)]);
    let TransactionRecords::Committed(records) = decode_transaction(&t, &program()).unwrap() else {
        panic!()
    };
    assert_eq!(records.len(), 2);
    assert!(matches!(records[0], ProgramRecord::Ps2 { .. }));
    assert_eq!(records[0].body(), old);
    assert_eq!(records[1].body(), wide);
    assert_eq!(
        records[1]
            .wide()
            .unwrap()
            .unwrap()
            .province_of()
            .unwrap()
            .coord()
            .p(),
        9_007_199_254_740_993
    );
    assert_eq!(
        fclient::log::bodies_from_logs(&t.logs, &program()),
        Err(fclient::log::LogError::UnsupportedWideRecord)
    );
}
#[test]
fn unknown_versions_kinds_tags_and_malformed_bodies_never_become_empty() {
    let valid = psw1();
    for (offset, value) in [(0, 0x81), (0, 0x83), (1, 255)] {
        let mut bad = valid.clone();
        bad[offset] = value;
        assert!(matches!(
            decode_transaction(&framed(vec![line(b"PSW1", &bad)]), &program()),
            Err(DecodeError::Psw1(_))
        ));
    }
    let mut tail = valid.clone();
    tail.push(0);
    for data in [
        line(b"PSW1", &tail),
        line(b"PS2", &[1, 255, 0, 0, 0, 0, 0]),
        line(b"OTHER", &valid),
        "Program data: !!! ???".into(),
        "Program data: UFNXMQ==".into(),
        "Program data:".into(),
        "Program data:\tUFNXMQ== AAA=".into(),
        format!("{} AAA=", line(b"PSW1", &valid)),
    ] {
        assert!(decode_transaction(&framed(vec![data]), &program()).is_err());
    }
}
#[test]
fn complete_frames_are_required_and_other_programs_cannot_inject() {
    let p = program();
    let o = other();
    let data = line(b"PSW1", &psw1());
    let valid = tx(vec![
        format!("Program {p} invoke [1]"),
        format!("Program {o} invoke [2]"),
        "Program data: !!! ???".into(),
        format!("Program {o} success"),
        data.clone(),
        format!("Program {p} success"),
    ]);
    let TransactionRecords::Committed(r) = decode_transaction(&valid, &p).unwrap() else {
        panic!()
    };
    assert_eq!(r.len(), 1);
    for logs in [
        vec![],
        vec![data.clone()],
        vec![
            format!("Program {p} invoke [2]"),
            data.clone(),
            format!("Program {p} success"),
        ],
        vec![format!("Program {p} invoke [1]"), data.clone()],
        vec![
            format!("Program {p} invoke [1]"),
            data,
            format!("Program {o} success"),
        ],
        vec![
            format!("Program {p} invoke [1]"),
            "Log truncated".into(),
            format!("Program {p} success"),
        ],
        vec![
            format!("Program {p} invoke [1]"),
            format!("Program {p} failed: error"),
        ],
    ] {
        assert!(decode_transaction(&tx(logs), &p).is_err());
    }
}
#[test]
fn rolled_back_cpi_subtrees_and_failed_transactions_never_emit_events() {
    let p = program();
    let o = other();
    let data = line(b"PSW1", &psw1());
    // The target succeeded in a grandchild; its parent failed and was caught.
    let t = tx(vec![
        format!("Program {o} invoke [1]"),
        format!("Program {o} invoke [2]"),
        format!("Program {p} invoke [3]"),
        data.clone(),
        format!("Program {p} success"),
        format!("Program {o} failed: caught"),
        format!("Program {p} invoke [2]"),
        data.clone(),
        format!("Program {p} success"),
        format!("Program {o} success"),
    ]);
    let TransactionRecords::Committed(r) = decode_transaction(&t, &p).unwrap() else {
        panic!()
    };
    assert_eq!(r.len(), 1);
    // A malformed record from a failed target CPI is discarded before decode.
    let t = tx(vec![
        format!("Program {o} invoke [1]"),
        format!("Program {p} invoke [2]"),
        "Program data: !!! ???".into(),
        format!("Program {p} failed: caught"),
        format!("Program {o} success"),
    ]);
    assert_eq!(
        decode_transaction(&t, &p),
        Ok(TransactionRecords::Committed(vec![]))
    );
    let mut failed = framed(vec![data]);
    failed.err = Some("runtime rollback".into());
    assert_eq!(
        decode_transaction(&failed, &p),
        Ok(TransactionRecords::RolledBack)
    );
}
