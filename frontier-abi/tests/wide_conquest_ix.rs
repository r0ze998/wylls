#![cfg(feature = "world-index-experimental")]
//! Provisional wire tests only: literal payloads, no keys or cryptography.
use frontier_abi::{
    error::FrontierError,
    prologue::{bounds_in, Acc, Wr},
    tags::Class,
    world_index::wide_ix::*,
};

fn wires() -> Vec<Vec<u8>> {
    vec![
        DeclareSiege { site: 7, entry: 55 }.to_bytes().to_vec(),
        SettleSiege { site: 7 }.to_bytes().to_vec(),
        SettleCapture { site: 7 }.to_bytes().to_vec(),
        ResolveWithConquest {
            bell: 0x12345678,
            beneficiary: [0xa5; 32],
        }
        .to_bytes()
        .to_vec(),
        CloseConquest {
            p: i64::MIN,
            q: i64::MAX,
        }
        .to_bytes()
        .to_vec(),
        CloseCaptureEscrow.to_bytes().to_vec(),
    ]
}

#[test]
fn exact_provisional_wire_and_roundtrip() {
    let bytes = wires();
    assert_eq!(bytes[0], [0xda, 0xff, 1, 5, 7, 55]);
    assert_eq!(bytes[1], [0xde, 0xff, 1, 5, 7]);
    assert_eq!(bytes[2], [0xdc, 0xff, 1, 8, 7]);
    assert_eq!(&bytes[3][..8], &[0xdc, 0xff, 1, 9, 0x78, 0x56, 0x34, 0x12]);
    assert_eq!(&bytes[3][8..], &[0xa5; 32]);
    assert_eq!(&bytes[4][..4], &[0xde, 0xff, 1, 3]);
    assert_eq!(&bytes[4][4..12], &i64::MIN.to_le_bytes());
    assert_eq!(&bytes[4][12..], &i64::MAX.to_le_bytes());
    assert_eq!(bytes[5], [0xde, 0xff, 1, 4]);
    assert_eq!(
        DeclareSiege::decode(&bytes[0])
            .unwrap()
            .to_bytes()
            .as_slice(),
        bytes[0]
    );
    assert_eq!(
        SettleSiege::decode(&bytes[1])
            .unwrap()
            .to_bytes()
            .as_slice(),
        bytes[1]
    );
    assert_eq!(
        SettleCapture::decode(&bytes[2])
            .unwrap()
            .to_bytes()
            .as_slice(),
        bytes[2]
    );
    assert_eq!(
        ResolveWithConquest::decode(&bytes[3])
            .unwrap()
            .to_bytes()
            .as_slice(),
        bytes[3]
    );
    assert_eq!(
        CloseConquest::decode(&bytes[4])
            .unwrap()
            .to_bytes()
            .as_slice(),
        bytes[4]
    );
    assert_eq!(
        CloseCaptureEscrow::decode(&bytes[5]),
        Ok(CloseCaptureEscrow)
    );
    // The common resolve payload does not make its account shape interchangeable.
    assert!(Resolve::decode(&bytes[3]).is_err());
    assert!(ResolveWithConquest::decode(
        &Resolve {
            bell: 1,
            beneficiary: [0; 32]
        }
        .to_bytes()
    )
    .is_err());
}

#[test]
fn malformed_envelopes_are_not_prefix_decoded() {
    // The mistaken class-D proposal was never allocated or activated.
    assert_eq!(
        WideCommand::decode(&[0xdc, 0xff, 1, 7, 7]),
        Err(FrontierError::BadData)
    );
    assert_eq!(
        SettleSiege::decode(&[0xdc, 0xff, 1, 7, 7]),
        Err(FrontierError::BadData)
    );
    // The old bare transit close remains distinct from DE's new envelope op 5.
    assert_eq!(
        WideCommand::decode(&[0xde, 5]),
        Ok(WideCommand::Close(Close {
            what: CLOSE_WHAT_TRANSIT
        }))
    );

    for bytes in wires() {
        // A two-byte DC FF remains the old SettleTicket; all other prefixes fail.
        for n in 0..bytes.len() {
            if n == 2 && bytes[0] == TAG_SETTLE_TICKET {
                continue;
            }
            assert_eq!(
                WideCommand::decode(&bytes[..n]),
                Err(FrontierError::BadData)
            );
        }
        let mut extra = bytes.clone();
        extra.push(0);
        assert_eq!(WideCommand::decode(&extra), Err(FrontierError::BadData));
        for (i, value) in [(0, 0xfe), (1, 0xfe), (2, 0), (2, 2), (3, 0), (3, 0xff)] {
            let mut bad = bytes.clone();
            bad[i] = value;
            assert_eq!(WideCommand::decode(&bad), Err(FrontierError::BadData));
        }
        assert!(frontier_abi::v2::ix::tag_of(&bytes).is_err());
        assert!(frontier_abi::ix::tag_of(&bytes).is_err());
    }
    assert_eq!(
        WideCommand::decode(&[0xde, 3]),
        Ok(WideCommand::Close(Close {
            what: CLOSE_WHAT_DAY
        }))
    );
    assert_eq!(
        WideCommand::decode(&[0xde, 4]),
        Ok(WideCommand::Close(Close {
            what: CLOSE_WHAT_INPUTS
        }))
    );
    assert_eq!(
        WideCommand::decode(&[0xdc, 0xff]),
        Ok(WideCommand::SettleTicket(SettleTicket { k: 0xff }))
    );
}

#[test]
fn decoded_class_top_level_and_account_shapes() {
    let classes = [Class::P, Class::N, Class::D, Class::D, Class::N, Class::N];
    let names = [
        "WideDeclareSiege",
        "WideSettleSiege",
        "WideSettleCapture",
        "WideResolveWithConquest",
        "WideCloseConquest",
        "WideCloseCaptureEscrow",
    ];
    let tables = [
        DECLARE_SIEGE,
        SETTLE_SIEGE,
        SETTLE_CAPTURE,
        RESOLVE_WITH_CONQUEST,
        CLOSE_CONQUEST,
        CLOSE_CAPTURE_ESCROW,
    ];
    let counts = [(12, 12), (7, 8), (10, 10), (10, 10), (4, 4), (5, 6)];
    for (i, bytes) in wires().iter().enumerate() {
        let c = WideCommand::decode(bytes).unwrap();
        assert_eq!(c.class(), classes[i]);
        assert_eq!(c.name(), names[i]);
        assert_eq!(c.accounts(), tables[i]);
        assert_eq!(bounds_in(c.accounts()), counts[i]);
        assert_eq!(c.top_level_only(), i == 3);
        assert_eq!(c.is_player(), i == 0);
        assert!(!c.march_stage());
    }
    assert_eq!(&RESOLVE_WITH_CONQUEST[0].specs[..9], RESOLVE[0].specs);
    for (table, index) in [
        (DECLARE_SIEGE, 8),
        (SETTLE_CAPTURE, 8),
        (CLOSE_CAPTURE_ESCROW, 2),
    ] {
        assert_eq!(table[0].specs[index].acc, Acc::Any);
    }
    assert_eq!(SettleSiege::IX, WideIx::Close);
    assert_eq!(SETTLE_SIEGE[0].specs[0].name, "any");
    assert_eq!(SETTLE_SIEGE[0].specs[0].acc, Acc::Wallet);
    assert_eq!(SETTLE_SIEGE[0].specs[0].wr, Wr::R);
    assert!(SETTLE_SIEGE[0].specs[0].signer);
    assert_eq!(SETTLE_SIEGE[0].specs[6].name, "escrow_funder");
    assert_eq!(SETTLE_SIEGE[1].specs[0].acc, Acc::Any);
    assert_eq!(SETTLE_SIEGE[1].specs[0].wr, Wr::W);
    assert_eq!((SETTLE_SIEGE[1].min, SETTLE_SIEGE[1].max), (0, 1));
    assert_eq!(DECLARE_SIEGE[0].specs[5].wr, Wr::W);
    assert_eq!(DECLARE_SIEGE[0].specs[7].wr, Wr::R);
    assert!(DECLARE_SIEGE[0].specs[0].signer && DECLARE_SIEGE[0].specs[1].signer);
    assert_eq!(
        (CLOSE_CAPTURE_ESCROW[1].min, CLOSE_CAPTURE_ESCROW[1].max),
        (0, 1)
    );
    assert_eq!(CLOSE_CAPTURE_ESCROW[1].specs[0].wr, Wr::W);
}

#[test]
fn resident_wrapper_accepts_only_declare_wire_not_lifecycle_activation() {
    for (i, inner) in wires().iter().enumerate() {
        let mut wrapped = vec![TAG_RESIDENT_ACT];
        wrapped.extend_from_slice(&42u32.to_le_bytes());
        wrapped.extend_from_slice(inner);
        if i == 0 {
            let act = ResidentAct::decode(&wrapped).unwrap();
            assert_eq!(act.generation, 42);
            assert_eq!(act.command(), WideCommand::decode(inner));
            wrapped.push(0);
            assert_eq!(ResidentAct::decode(&wrapped), Err(FrontierError::BadData));
        } else {
            assert_eq!(ResidentAct::decode(&wrapped), Err(FrontierError::BadData));
        }
    }
}
