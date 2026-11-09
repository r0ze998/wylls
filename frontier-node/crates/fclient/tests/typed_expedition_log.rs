//! Exact immutable native log observations; no runtime or network.
#![cfg(feature = "wide-records-experimental")]
#[path = "fixtures/original_boundary.rs"]
mod fixture;
use fclient::typed_log::*;
#[test]
fn native_trace_preserves_scoped_bytes_and_old_reader_refusals() {
    let (c, txs) = fixture::trace();
    let p = fclient::Address::new_from_array(c.program);
    let mut kinds = std::collections::BTreeSet::new();
    for tx in txs {
        let TransactionRecords::Committed(records) =
            decode_transaction_with_expedition(&tx, &p, &c).unwrap()
        else {
            panic!()
        };
        for r in &records {
            if r.format() != "PSWC" {
                kinds.insert((r.format(), r.body()[1]));
            }
        }
        if records.iter().any(|r| r.expedition(&c).unwrap().is_some()) {
            assert!(decode_transaction(&tx, &p).is_err());
            assert!(decode_transaction_with_resident(&tx, &p, &c).is_err());
            let mut wrong = c;
            wrong.season[0] ^= 1;
            assert!(decode_transaction_with_expedition(&tx, &p, &wrong).is_err());
        }
    }
    for k in [
        ("PS2", 145),
        ("PS2", 146),
        ("PS2", 147),
        ("PS2", 148),
        ("PSW1", 25),
    ] {
        assert!(kinds.contains(&k), "{k:?}");
    }
}
#[test]
fn native_pairs_reject_orphans_duplicates_corruption_and_tag_swaps() {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let (c, txs) = fixture::trace();
    let p = fclient::Address::new_from_array(c.program);
    for tx in txs {
        let TransactionRecords::Committed(records) =
            decode_transaction_with_expedition(&tx, &p, &c).unwrap()
        else {
            panic!()
        };
        if !records.iter().any(|r| {
            matches!(
                r.expedition(&c).unwrap(),
                Some(ExpeditionRecord::Settlement(_) | ExpeditionRecord::LegacySource(_))
            )
        }) {
            continue;
        }
        assert_eq!(records.len(), 2);
        for (ordinal, record) in records.iter().enumerate() {
            let mut bad = tx.clone();
            let tag = if record.format() == "PS2" {
                "PSW1"
            } else {
                "PS2"
            };
            bad.logs[ordinal + 1] = format!(
                "Program data: {} {}",
                b64.encode(tag),
                b64.encode(record.body())
            );
            assert!(decode_transaction_with_expedition(&bad, &p, &c).is_err());
            let mut body = record.body().to_vec();
            body[10] ^= 1; // Canonical key world byte, not an unconstrained digest.
            bad.logs[ordinal + 1] = format!(
                "Program data: {} {}",
                b64.encode(record.format()),
                b64.encode(body)
            );
            assert!(decode_transaction_with_expedition(&bad, &p, &c).is_err());
        }
        for removed in [1, 2] {
            let mut bad = tx.clone();
            bad.logs.remove(removed);
            let remaining = &records[2 - removed];
            let valid_lone_capture = matches!(remaining.wide(), Ok(Some(w)) if w.kind == frontier_abi::world_index::event::WideKind::ConquestCaptured);
            assert_eq!(
                decode_transaction_with_expedition(&bad, &p, &c).is_ok(),
                valid_lone_capture
            );
        }
        let mut bad = tx.clone();
        bad.logs.insert(1, bad.logs[1].clone());
        assert!(decode_transaction_with_expedition(&bad, &p, &c).is_err());
        let mut bad = tx.clone();
        bad.err = Some("failed".into());
        assert_eq!(
            decode_transaction_with_expedition(&bad, &p, &c).unwrap(),
            TransactionRecords::RolledBack
        );
    }
}
#[test]
fn rolled_back_child_discards_orphan_and_producer_tail_is_zero() {
    use base64::Engine;
    let (c, txs) = fixture::trace();
    let p = fclient::Address::new_from_array(c.program);
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut checked = false;
    for tx in txs {
        let TransactionRecords::Committed(records) =
            decode_transaction_with_expedition(&tx, &p, &c).unwrap()
        else {
            panic!()
        };
        for r in records {
            if matches!(
                r.expedition(&c).unwrap(),
                Some(ExpeditionRecord::Producer(_))
            ) {
                let mut body = r.body().to_vec();
                assert_eq!(body.pop(), Some(0));
                body.push(1);
                let mut bad = tx.clone();
                bad.logs = fclient::log::in_frame(
                    &p,
                    [format!(
                        "Program data: {} {}",
                        b64.encode(b"PS2"),
                        b64.encode(body)
                    )],
                );
                assert!(decode_transaction_with_expedition(&bad, &p, &c).is_err());
                checked = true;
            }
            if matches!(
                r.expedition(&c).unwrap(),
                Some(ExpeditionRecord::Settlement(_))
            ) {
                let outer = fclient::Address::new_from_array([77; 32]);
                let mut child = tx.clone();
                child.logs = vec![
                    format!("Program {outer} invoke [1]"),
                    format!("Program {p} invoke [2]"),
                    format!(
                        "Program data: {} {}",
                        b64.encode(r.format()),
                        b64.encode(r.body())
                    ),
                    format!("Program {p} failed: caught"),
                    format!("Program {outer} success"),
                ];
                assert_eq!(
                    decode_transaction_with_expedition(&child, &p, &c).unwrap(),
                    TransactionRecords::Committed(vec![])
                );
            }
        }
    }
    assert!(checked);
}

#[path = "fixtures/conquest_observation.rs"]
mod conquest_fixture;
#[test]
fn optional_credit_targets_are_observations_but_sources_and_declarations_require_pairs() {
    use frontier_abi::world_index::event::{conquest as c, WideKind as K};
    let ctx = conquest_fixture::ctx();
    let p = fclient::Address::new_from_array(ctx.program);
    for (kind, action) in [
        (K::ConquestSettled, c::LAPSE),
        (K::ConquestCaptured, c::CAPTURE),
    ] {
        let target = conquest_fixture::body(kind, action, 7);
        let source = conquest_fixture::body(K::ConquestCredited, action, 7);
        let conflict = conquest_fixture::body(K::ConquestCredited, action, 9);
        for parts in [
            vec![(b"PSW1".as_slice(), target.as_slice())],
            vec![
                (b"PSW1".as_slice(), target.as_slice()),
                (b"PSW1", source.as_slice()),
            ],
        ] {
            assert!(
                decode_transaction_with_expedition(&conquest_fixture::tx(&parts), &p, &ctx).is_ok()
            );
        }
        for parts in [
            vec![(b"PSW1".as_slice(), source.as_slice())],
            vec![
                (b"PSW1".as_slice(), target.as_slice()),
                (b"PSW1", target.as_slice()),
            ],
            vec![
                (b"PSW1".as_slice(), target.as_slice()),
                (b"PSW1", conflict.as_slice()),
            ],
        ] {
            assert!(
                decode_transaction_with_expedition(&conquest_fixture::tx(&parts), &p, &ctx)
                    .is_err()
            );
        }
    }
    for kind in [K::ConquestDeclared, K::ConquestDebited] {
        let body = conquest_fixture::body(kind, c::DECLARE, 7);
        assert!(decode_transaction_with_expedition(
            &conquest_fixture::tx(&[(b"PSW1", &body)]),
            &p,
            &ctx
        )
        .is_err());
    }
}
