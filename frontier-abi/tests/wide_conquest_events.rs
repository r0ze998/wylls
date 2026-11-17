//! Literal public identities and bytes only. No keys, signatures or runtime IO.
#![cfg(feature = "world-index-experimental")]
use frontier_abi::layout::header;
use frontier_abi::world_index::event::{conquest::*, *};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};

fn context() -> Context<'static> {
    Context {
        command: &[0xdc, 0xff, 1, 8],
        now_ts: 45,
        bell: 12,
        season: &[9; 200],
        evidence: &[8; 32],
    }
}
fn account<'a>(data: &'a [u8]) -> AccountSnapshot<'a> {
    AccountSnapshot {
        role: 1,
        address: [3; 32],
        owner: [4; 32],
        present: true,
        lamports: 123,
        data,
        chained: false,
    }
}
fn receipt(action: u8) -> Receipt {
    Receipt::new(action, 0, [1; 32], [2; 32]).unwrap()
}

#[test]
fn canonical_receipt_ranges_lengths_reserved_and_binding() {
    for action in DECLARE..=ESCROW_CLOSE {
        let r = receipt(action);
        let bytes = r.encode();
        assert_eq!(bytes.len(), 100);
        assert_eq!(Receipt::decode(&bytes), Ok(r));
        for i in [0, 1, 2, 3, 4, 35, 36, 67, 68, 99] {
            let mut bad = bytes;
            bad[i] ^= 0x80;
            assert!(Receipt::decode(&bad).is_err(), "byte {i}");
        }
        assert!(Receipt::decode(&bytes[..99]).is_err());
        assert!(Receipt::decode(&[bytes.as_slice(), &[0]].concat()).is_err());
    }
    for action in [0, 8, 255] {
        assert!(Receipt::new(action, 0, [1; 32], [2; 32]).is_err());
    }
    assert!(Receipt::new(DECLARE, 1, [1; 32], [2; 32]).is_err());
    assert_ne!(receipt(DECLARE).operation_id, receipt(RESOLVE).operation_id);
}

#[test]
fn exact_kind_key_link_shapes_and_cross_operation_receipt_rejection() {
    assert!(receipt(FAILED)
        .validate_kind(WideKind::ConquestCredited)
        .is_err());
    let province = ProvinceKey::new(
        WorldId::new([7; 32]).unwrap(),
        WideCoord::checked(129, 0).unwrap(),
    );
    let holding = WideHostRef::new(province, 0, 1, 0).unwrap();
    for (kind, action, entities) in [
        (
            WideKind::ConquestDeclared,
            DECLARE,
            vec![WideEntity::Province],
        ),
        (
            WideKind::ConquestDebited,
            DECLARE,
            vec![WideEntity::Holding],
        ),
        (
            WideKind::ConquestResolved,
            RESOLVE,
            vec![WideEntity::Province],
        ),
        (
            WideKind::ConquestSettled,
            FAILED,
            vec![WideEntity::Province],
        ),
        (
            WideKind::ConquestCaptured,
            CAPTURE,
            vec![WideEntity::Province, WideEntity::Holding],
        ),
        (
            WideKind::ConquestCredited,
            CAPTURE,
            vec![WideEntity::Holding],
        ),
        (WideKind::ConquestTableClosed, TABLE_CLOSE, vec![]),
    ] {
        assert!(!kind.host_keyed());
        assert_eq!(kind.links(), entities);
        let key = if kind.holding_keyed() {
            holding.to_bytes().to_vec()
        } else {
            province.to_bytes().to_vec()
        };
        let payload = receipt(action).encode();
        let mut body = [0; MAX_BODY];
        let n = write_body(kind, 12, &key, &payload, &mut body).unwrap();
        let links: Vec<_> = entities
            .iter()
            .map(|e| advance(*e, 0, &[0; 32], &body[..n]).unwrap())
            .collect();
        let encoded = encode(kind, 12, &key, &payload, &links).unwrap();
        let decoded = WideRecord::decode(&encoded).unwrap();
        assert_eq!(decoded.province_of(), Some(province));
        assert_eq!(
            decoded.holding_of(),
            if kind.holding_keyed() {
                Some(holding)
            } else {
                None
            }
        );
        assert!(write_body(kind, 12, &key, &receipt(ESCROW_CLOSE).encode(), &mut body).is_none());
        let mut wrong = links.clone();
        wrong.push(WideLink {
            entity: WideEntity::Holding,
            seq: 0,
            head: [0; 32],
        });
        assert!(encode(kind, 12, &key, &payload, &wrong).is_none());
        if !links.is_empty() {
            assert!(encode(kind, 12, &key, &payload, &[]).is_none());
        }
        if kind.holding_keyed() {
            let host = WideHostRef::new(province, 0, 1, 1).unwrap();
            assert!(write_body(kind, 12, &host.to_bytes(), &payload, &mut body).is_none());
        }
    }
}

#[test]
fn manifest_binds_whole_private_bytes_metadata_context_and_outcomes() {
    let c = context();
    let data = [5; 256];
    let a = account(&data);
    let before = input_digest(&c, &[a]).unwrap();
    let after = output_digest(&c, &[a], &[0; 16]).unwrap();
    assert_ne!(before, after);
    for i in 0..data.len() {
        let mut changed = data;
        changed[i] ^= 1;
        assert_ne!(input_digest(&c, &[account(&changed)]).unwrap(), before);
        assert_ne!(
            output_digest(&c, &[account(&changed)], &[0; 16]).unwrap(),
            after
        );
    }
    for changed in [
        AccountSnapshot {
            address: [8; 32],
            ..a
        },
        AccountSnapshot {
            owner: [8; 32],
            ..a
        },
        AccountSnapshot { role: 2, ..a },
        AccountSnapshot { lamports: 124, ..a },
        AccountSnapshot { chained: true, ..a },
    ] {
        assert_ne!(input_digest(&c, &[changed]).unwrap(), before);
    }
    for changed in [
        Context { command: &[1], ..c },
        Context { now_ts: 46, ..c },
        Context { bell: 13, ..c },
        Context {
            season: &[8; 200],
            ..c
        },
        Context {
            evidence: &[7; 32],
            ..c
        },
    ] {
        assert_ne!(input_digest(&changed, &[a]).unwrap(), before);
    }
    assert_ne!(output_digest(&c, &[a], &[1; 16]).unwrap(), after);
    let absent = AccountSnapshot {
        present: false,
        data: &[],
        ..a
    };
    assert_ne!(
        input_digest(&c, &[absent]).unwrap(),
        input_digest(
            &c,
            &[AccountSnapshot {
                lamports: 0,
                ..absent
            }]
        )
        .unwrap()
    );
    assert!(input_digest(
        &c,
        &[AccountSnapshot {
            present: false,
            ..a
        }]
    )
    .is_err());
    assert!(input_digest(&c, &[a, a]).is_err());
    assert!(input_digest(&c, &[a, AccountSnapshot { role: 2, ..a }]).is_ok());
    assert!(input_digest(
        &c,
        &[
            a,
            AccountSnapshot {
                role: 2,
                lamports: 99,
                ..a
            }
        ]
    )
    .is_err());
    assert!(input_digest(&c, &[]).is_err());
}

#[test]
fn only_actual_chained_outputs_are_normalized_and_all_holdings_remain_bound() {
    let c = context();
    let data = [5; 256];
    let mut changed = data;
    changed[header::EVENT_SEQ..header::EVENT_SEQ + 8].fill(9);
    changed[header::EVENT_HEAD..header::EVENT_HEAD + 32].fill(9);
    let a = AccountSnapshot {
        chained: true,
        ..account(&data)
    };
    let b = AccountSnapshot {
        data: &changed,
        ..a
    };
    assert_ne!(
        input_digest(&c, &[a]).unwrap(),
        input_digest(&c, &[b]).unwrap()
    );
    assert_eq!(
        output_digest(&c, &[a], &[]).unwrap(),
        output_digest(&c, &[b], &[]).unwrap()
    );
    let target = AccountSnapshot {
        role: 2,
        address: [8; 32],
        ..a
    };
    let table = AccountSnapshot {
        role: 3,
        address: [9; 32],
        chained: false,
        ..a
    };
    let expected = output_digest(&c, &[a, target, table], &[]).unwrap();
    assert_ne!(
        expected,
        output_digest(
            &c,
            &[
                a,
                target,
                AccountSnapshot {
                    data: &changed,
                    ..table
                }
            ],
            &[]
        )
        .unwrap()
    );
    let mut economic = data;
    economic[255] ^= 1;
    assert_ne!(
        expected,
        output_digest(
            &c,
            &[
                a,
                AccountSnapshot {
                    data: &economic,
                    ..target
                },
                table
            ],
            &[]
        )
        .unwrap()
    );
}

#[test]
fn citizen_close_is_separate_exact_format_without_province_attribution() {
    let close = SidecarClose {
        season: [8; 32],
        citizen: [9; 32],
        bell: 12,
        receipt: receipt(ESCROW_CLOSE),
    };
    let bytes = close.encode().unwrap();
    assert_eq!(SIDECAR_LOG_PREFIX, b"PSWC");
    assert_eq!(SidecarClose::decode(&bytes), Ok(close));
    assert!(WideRecord::decode(&bytes).is_err());
    assert!(SidecarClose::decode(&bytes[..168]).is_err());
    assert!(SidecarClose::decode(&[bytes.as_slice(), &[0]].concat()).is_err());
    assert!(SidecarClose {
        receipt: receipt(TABLE_CLOSE),
        ..close
    }
    .encode()
    .is_err());
}
