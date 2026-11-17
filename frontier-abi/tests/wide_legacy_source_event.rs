//! Literal public addresses and public hashes only; no runtime IO or signing.
#![cfg(feature = "world-index-experimental")]
use frontier_abi::world_index::{
    event::{self, conquest, WideKind, WideRecord},
    expedition::AccountResolver,
    legacy_source_event::{
        Direction, Error, Record, SourceReceipt, BODY_LEN, BODY_WITHOUT_TAIL_LEN, KIND,
    },
    ProvinceKey, WideCoord, WideHostRef, WorldId,
};
use frontier_abi::{addr::AddrCtx, log};

fn resolver() -> AccountResolver {
    AccountResolver::for_season(&AddrCtx {
        season: [7; 32],
        program: [9; 32],
    })
    .unwrap()
}
fn receipt(direction: Direction, action: u8) -> SourceReceipt {
    let resolver = resolver();
    let source = WideHostRef::new(
        ProvinceKey::new(
            resolver.adapter().world(),
            WideCoord::checked(128, 0).unwrap(),
        ),
        3,
        2,
        17,
    )
    .unwrap();
    SourceReceipt {
        direction,
        bell: 12,
        source,
        source_address: resolver.holding_address(&source).unwrap(),
        receipt: conquest::Receipt::new(action, 0, [1; 32], [2; 32]).unwrap(),
    }
}
fn target(source: &SourceReceipt, kind: WideKind, key: ProvinceKey) -> Vec<u8> {
    let payload = source.receipt.encode();
    let key = if kind.holding_keyed() {
        WideHostRef::new(key, 4, 3, 0).unwrap().to_bytes().to_vec()
    } else {
        key.to_bytes().to_vec()
    };
    let mut body = [0; event::MAX_BODY];
    let n = event::write_body(kind, source.bell, &key, &payload, &mut body).unwrap();
    let links: Vec<_> = kind
        .links()
        .iter()
        .map(|e| event::advance(*e, 0, &[0; 32], &body[..n]).unwrap())
        .collect();
    event::encode(kind, source.bell, &key, &payload, &links).unwrap()
}

#[test]
fn strict_shape_roundtrip_and_old_decoders_refuse() {
    let resolver = resolver();
    for (direction, action) in [
        (Direction::Debit, conquest::DECLARE),
        (Direction::Credit, conquest::LAPSE),
        (Direction::Credit, conquest::CAPTURE),
    ] {
        let source = receipt(direction, action);
        let (bytes, link) = source.prepare(&resolver, 27, &[4; 32]).unwrap();
        assert_eq!(bytes.len(), 240);
        let decoded = Record::decode(&resolver, &bytes).unwrap();
        assert_eq!(decoded, Record { source, link });
        assert_eq!(
            decoded.source.prepare(&resolver, 27, &[4; 32]).unwrap().0,
            bytes
        );
        assert!(matches!(
            log::decode(&bytes),
            Err(log::LogError::UnknownKind(KIND))
        ));
        assert!(matches!(
            frontier_abi::v2::log::decode(&bytes),
            Err(log::LogError::UnknownKind(KIND))
        ));
        for i in [0, 1, 6, 7, 8, 9, 10, 98, 101, 102, 198, 199] {
            let mut bad = bytes;
            bad[i] ^= 0x80;
            assert!(Record::decode(&resolver, &bad).is_err(), "byte {i}");
        }
        for n in 0..BODY_LEN {
            assert!(Record::decode(&resolver, &bytes[..n]).is_err());
        }
        assert!(Record::decode(&resolver, &[bytes.as_slice(), &[0]].concat()).is_err());
        let mut zero_seq = bytes;
        zero_seq[200..208].fill(0);
        assert_eq!(Record::decode(&resolver, &zero_seq), Err(Error::Chain));
    }
}

#[test]
fn rejects_wrong_family_world_address_and_noncredit_terminals() {
    let resolver = resolver();
    let base = receipt(Direction::Debit, conquest::DECLARE);
    for action in [
        conquest::RESOLVE,
        conquest::FAILED,
        conquest::LAPSE,
        conquest::CAPTURE,
        conquest::TABLE_CLOSE,
        conquest::ESCROW_CLOSE,
    ] {
        assert_eq!(
            receipt(Direction::Debit, action).validate(&resolver),
            Err(Error::Receipt)
        );
    }
    for action in [
        conquest::DECLARE,
        conquest::RESOLVE,
        conquest::FAILED,
        conquest::TABLE_CLOSE,
        conquest::ESCROW_CLOSE,
    ] {
        assert_eq!(
            receipt(Direction::Credit, action).validate(&resolver),
            Err(Error::Receipt)
        );
    }
    let mut bad = base;
    bad.source_address[0] ^= 1;
    assert_eq!(bad.validate(&resolver), Err(Error::Identity));
    for key in [
        ProvinceKey::new(WorldId::new([6; 32]).unwrap(), base.source.key().coord()),
        ProvinceKey::new(
            resolver.adapter().world(),
            WideCoord::checked(129, 0).unwrap(),
        ),
        ProvinceKey::new(
            resolver.adapter().world(),
            WideCoord::checked(1 << 40, 0).unwrap(),
        ),
    ] {
        let mut bad = base;
        bad.source = WideHostRef::new(key, 3, 2, 17).unwrap();
        assert_eq!(bad.validate(&resolver), Err(Error::Identity));
    }
}

#[test]
fn continues_existing_legacy_chain_and_detects_tamper_replay_and_overflow() {
    let resolver = resolver();
    let source = receipt(Direction::Debit, conquest::DECLARE);
    let mut ordinary_key = [0; 9];
    ordinary_key[..4].copy_from_slice(&128i32.to_le_bytes());
    ordinary_key[8] = source.source.site();
    let mut ordinary_body = [0; 128];
    let n = log::write_body(
        log::Kind::HARVEST,
        11,
        &ordinary_key,
        &[5; 32],
        &mut ordinary_body,
    )
    .unwrap();
    let previous =
        log::advance(log::EntityKind::Holding, 7, &[3; 32], &ordinary_body[..n]).unwrap();
    let (bytes, link) = source
        .prepare(&resolver, previous.seq, &previous.head)
        .unwrap();
    assert_eq!(link.entity as u8, 5);
    assert_eq!(link.seq, 9);
    assert_eq!(
        link.head,
        log::next_head(&previous.head, 9, &bytes[..BODY_WITHOUT_TAIL_LEN])
    );
    let record = Record::decode(&resolver, &bytes).unwrap();
    assert_eq!(
        record.verify_previous(&resolver, previous.seq, &previous.head),
        Ok(())
    );
    assert_eq!(
        record.verify_previous(&resolver, link.seq, &link.head),
        Err(Error::Chain)
    );
    assert_eq!(
        record.verify_previous(&resolver, 0, &[0; 32]),
        Err(Error::Chain)
    );
    assert_eq!(
        source.prepare(&resolver, u64::MAX, &[0; 32]),
        Err(Error::Chain)
    );
    for i in [2, 61, 65, 200, 208, 239] {
        let mut bad = bytes;
        bad[i] ^= 1;
        let decoded = Record::decode(&resolver, &bad).unwrap();
        assert_eq!(
            decoded.verify_previous(&resolver, previous.seq, &previous.head),
            Err(Error::Chain)
        );
    }
    let mut wide_hash = bytes;
    wide_hash[208..240].copy_from_slice(&event::next_head(
        event::WideEntity::Holding,
        link.seq,
        &previous.head,
        &bytes[..BODY_WITHOUT_TAIL_LEN],
    ));
    assert_eq!(
        Record::decode(&resolver, &wide_hash)
            .unwrap()
            .verify_previous(&resolver, previous.seq, &previous.head),
        Err(Error::Chain)
    );
    let next = receipt(Direction::Credit, conquest::LAPSE);
    let (bytes, _) = next.prepare(&resolver, link.seq, &link.head).unwrap();
    assert!(Record::decode(&resolver, &bytes)
        .unwrap()
        .verify_previous(&resolver, link.seq, &link.head)
        .is_ok());
}

#[test]
fn target_pair_requires_same_receipt_action_bell_and_world() {
    let resolver = resolver();
    let key = ProvinceKey::new(
        resolver.adapter().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    for (direction, action, kind) in [
        (
            Direction::Debit,
            conquest::DECLARE,
            WideKind::ConquestDeclared,
        ),
        (
            Direction::Credit,
            conquest::LAPSE,
            WideKind::ConquestSettled,
        ),
        (
            Direction::Credit,
            conquest::CAPTURE,
            WideKind::ConquestCaptured,
        ),
    ] {
        let source = receipt(direction, action);
        let bytes = target(&source, kind, key);
        let decoded = WideRecord::decode(&bytes).unwrap();
        assert_eq!(source.pair_target(&resolver, &decoded), Ok(()));
        let mut changed = source;
        changed.receipt = conquest::Receipt::new(action, 0, [5; 32], [2; 32]).unwrap();
        assert_eq!(changed.pair_target(&resolver, &decoded), Err(Error::Pair));
        changed = source;
        changed.bell += 1;
        assert_eq!(changed.pair_target(&resolver, &decoded), Err(Error::Pair));
        for wrong_key in [
            source.source.key(),
            ProvinceKey::new(WorldId::new([8; 32]).unwrap(), key.coord()),
        ] {
            if kind.holding_keyed() && wrong_key == source.source.key() {
                // CAPTURE uses the wide Holding key codec, which already
                // refuses a legacy-disk target at the encoder boundary.
                let invalid_key = WideHostRef::new(wrong_key, 4, 3, 0).unwrap().to_bytes();
                assert!(event::write_body(
                    kind,
                    source.bell,
                    &invalid_key,
                    &source.receipt.encode(),
                    &mut [0; event::MAX_BODY],
                )
                .is_none());
                let mut forged = decoded;
                forged.key = &invalid_key;
                assert_eq!(source.pair_target(&resolver, &forged), Err(Error::Pair));
                continue;
            }
            let wrong = target(&source, kind, wrong_key);
            assert_eq!(
                source.pair_target(&resolver, &WideRecord::decode(&wrong).unwrap()),
                Err(Error::Pair)
            );
        }
        let mut wrong = decoded;
        wrong.kind = WideKind::ConquestResolved;
        assert_eq!(source.pair_target(&resolver, &wrong), Err(Error::Pair));
        let mut wrong = decoded;
        wrong.body_without_tail = &[];
        assert_eq!(source.pair_target(&resolver, &wrong), Err(Error::Pair));
        let mut wrong = decoded;
        wrong.links[0] = None;
        assert_eq!(source.pair_target(&resolver, &wrong), Err(Error::Pair));
    }
}
