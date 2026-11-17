//! Pure wire fixtures only; no signing, runtime or network.
#![cfg(feature = "wide-records-experimental")]
#[path = "fixtures/resident.rs"]
mod fixture;
use fclient::typed_log::{
    decode_transaction, decode_transaction_with_resident, TransactionRecords,
};
use frontier_abi::world_index::expedition_resident_event::Action;
#[test]
fn resident_pairs_are_scoped_canonical_and_never_generic() {
    let ctx = fixture::ctx();
    let program = fclient::Address::new_from_array(ctx.program);
    for action in [Action::Dissolve, Action::Return] {
        let (a, b) = fixture::pair(action, fixture::zero());
        let tx = fixture::tx(&[(b"PS2", &a), (b"PSW1", &b)]);
        assert!(decode_transaction(&tx, &program).is_err());
        assert!(fclient::log::Record::decode_v2(&a).is_err());
        let TransactionRecords::Committed(records) =
            decode_transaction_with_resident(&tx, &program, &ctx).unwrap()
        else {
            panic!()
        };
        assert_eq!(records.len(), 2);
        for r in records {
            assert!(r.wide().is_err());
            assert_eq!(r.resident(&ctx).unwrap().unwrap().action, action);
        }
        for parts in [
            vec![(b"PS2".as_slice(), a.as_slice())],
            vec![(b"PSW1".as_slice(), b.as_slice())],
            vec![
                (b"PS2".as_slice(), a.as_slice()),
                (b"PS2", &a),
                (b"PSW1", &b),
            ],
            vec![(b"PSW1".as_slice(), a.as_slice()), (b"PS2", &b)],
        ] {
            assert!(
                decode_transaction_with_resident(&fixture::tx(&parts), &program, &ctx).is_err()
            );
        }
        let mut bad = b.clone();
        bad[66] ^= 1;
        assert!(decode_transaction_with_resident(
            &fixture::tx(&[(b"PS2", &a), (b"PSW1", &bad)]),
            &program,
            &ctx
        )
        .is_err());
        let mut wrong = ctx;
        wrong.season = [5; 32];
        assert!(decode_transaction_with_resident(&tx, &program, &wrong).is_err());
    }
}
#[test]
fn failed_transaction_never_needs_a_resident_pair() {
    let c = fixture::ctx();
    let p = fclient::Address::new_from_array(c.program);
    let (a, _) = fixture::pair(Action::Return, fixture::zero());
    let mut tx = fixture::tx(&[(b"PS2", &a)]);
    tx.err = Some("failed".into());
    assert_eq!(
        decode_transaction_with_resident(&tx, &p, &c).unwrap(),
        TransactionRecords::RolledBack
    );
}

/// Decode exact native-output bodies only. This does not replay account effects,
/// verify prior heads, index from zero, or execute any transaction.
#[test]
fn actual_native_bres_receipts_preserve_exact_scoped_bytes() {
    use base64::Engine;
    use frontier_abi::{addr::AddrCtx, world_index::WideHostRef};
    use sha2::{Digest, Sha256};
    fn take<'a>(bytes: &mut &'a [u8], n: usize) -> &'a [u8] {
        assert!(n <= bytes.len());
        let (head, tail) = bytes.split_at(n);
        *bytes = tail;
        head
    }
    fn sized<'a>(bytes: &mut &'a [u8]) -> &'a [u8] {
        let n = u32::from_le_bytes(take(bytes, 4).try_into().unwrap()) as usize;
        assert!(n <= 65_536);
        take(bytes, n)
    }
    for (bytes, digest, action) in [
        (
            include_bytes!("../../verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin")
                .as_slice(),
            "0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84",
            Action::Dissolve,
        ),
        (
            include_bytes!("../../verify/tests/fixtures/wide_expedition_resident/return_v1.bin")
                .as_slice(),
            "6f22a8e606852e52d87f66e0f2452fd00c6a26aa42716a2fc874feb4643d7da3",
            Action::Return,
        ),
    ] {
        assert!(bytes.len() < 1024 * 1024);
        assert_eq!(hex::encode(Sha256::digest(bytes)), digest);
        let mut remaining = bytes;
        assert_eq!(take(&mut remaining, 8), b"BRESv001");
        assert_eq!(take(&mut remaining, 1), &[action as u8]);
        let ctx = AddrCtx {
            program: take(&mut remaining, 32).try_into().unwrap(),
            season: take(&mut remaining, 32).try_into().unwrap(),
        };
        let host = WideHostRef::from_bytes(take(&mut remaining, 56)).unwrap();
        take(&mut remaining, 8); // Native context timestamp, not replayed here.
        let slot = u64::from_le_bytes(take(&mut remaining, 8).try_into().unwrap());
        let count = take(&mut remaining, 1)[0] as usize;
        assert_eq!(count, if action == Action::Dissolve { 8 } else { 6 });
        for _ in 0..2 * count {
            take(&mut remaining, 64); // Public address and owner.
            assert!(take(&mut remaining, 4).iter().all(|b| *b <= 1));
            take(&mut remaining, 8); // Lamports, not replayed here.
            sized(&mut remaining); // Exact before/after account bytes skipped.
        }
        assert_eq!(take(&mut remaining, 1), &[2]);
        let original = sized(&mut remaining);
        let wide = sized(&mut remaining);
        assert!(remaining.is_empty());
        let program = fclient::Address::new_from_array(ctx.program);
        let b64 = base64::engine::general_purpose::STANDARD;
        let logs = [(b"PS2".as_slice(), original), (b"PSW1".as_slice(), wide)]
            .map(|(tag, body)| format!("Program data: {} {}", b64.encode(tag), b64.encode(body)));
        // TxRecord is only a supplied log container; no transaction is built/sent.
        let mut tx = fixture::tx(&[]);
        tx.slot = slot;
        tx.logs = fclient::log::in_frame(&program, logs);
        assert!(decode_transaction(&tx, &program).is_err());
        let TransactionRecords::Committed(records) =
            decode_transaction_with_resident(&tx, &program, &ctx).unwrap()
        else {
            panic!("committed native receipt fixture")
        };
        assert_eq!(records.len(), 2);
        for (record, exact) in records.iter().zip([original, wide]) {
            assert_eq!(record.body(), exact);
            let resident = record.resident(&ctx).unwrap().unwrap();
            assert_eq!(resident.action, action);
            assert_eq!(resident.identity.host, host);
        }
        assert_eq!(hex::encode(Sha256::digest(bytes)), digest);
    }
}
