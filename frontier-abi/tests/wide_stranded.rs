//! Provisional host-only wire tests. Pure codecs/tables; no keys or signing.
#![cfg(feature = "world-index-experimental")]

use frontier_abi::error::FrontierError;
use frontier_abi::layout::AccountKind;
use frontier_abi::prologue::{bounds_in, position_in, Acc, Wr};
use frontier_abi::tags::Class;
use frontier_abi::world_index::wide_ix::{
    Close, CloseRoster, DisbandStranded, ResidentAct, WideCommand, WideIx, CLOSE_WHAT_MAX,
    DISBAND_STRANDED, DISBAND_STRANDED_TRANSIT0, OP_DISBAND_STRANDED, TAG_CLOSE,
};

#[test]
fn stranded_wire_is_exact_and_nonplayer() {
    assert_eq!(OP_DISBAND_STRANDED, 2);
    assert_eq!(DisbandStranded::LEN, 5);
    for entry in 0..=55 {
        let value = DisbandStranded { entry };
        let bytes = value.to_bytes();
        assert_eq!(bytes, [0xde, 0xff, 1, 2, entry]);
        assert_eq!(DisbandStranded::decode(&bytes), Ok(value));
        let command = WideCommand::decode(&bytes).unwrap();
        assert_eq!(command, WideCommand::DisbandStranded(value));
        assert_eq!(command.ix(), WideIx::Close);
        assert_eq!(command.ix().tag(), TAG_CLOSE);
        assert_eq!(command.name(), "WideDisbandStranded");
        assert_eq!(command.class(), Class::N);
        assert!(!command.is_player());
        assert!(!command.top_level_only());
        assert!(!command.march_stage());
        assert!(!command.ix().act_runs());
        assert_eq!(command.accounts(), DISBAND_STRANDED);
        assert!(frontier_abi::ix::tag_of(&bytes).is_err());
        assert!(frontier_abi::v2::ix::tag_of(&bytes).is_err());

        let act = ResidentAct {
            generation: 3,
            inner: &bytes,
        };
        let mut wrapped = [0; ResidentAct::HEAD + DisbandStranded::LEN];
        assert_eq!(act.encode_into(&mut wrapped), Some(wrapped.len()));
        assert_eq!(ResidentAct::decode(&wrapped), Err(FrontierError::BadData));
        assert_eq!(WideCommand::decode(&wrapped), Err(FrontierError::BadData));
    }
}

#[test]
fn entry_range_remains_a_handler_check_like_legacy() {
    // The legacy codec accepts every u8. Decoding is not permission to
    // address entries outside 0..56: both handlers must reject those.
    for entry in 56..=u8::MAX {
        let legacy = frontier_abi::ix::DisbandStranded { entry };
        assert_eq!(
            frontier_abi::ix::DisbandStranded::decode(&legacy.to_bytes()),
            Ok(legacy)
        );
        let wide = DisbandStranded { entry };
        assert_eq!(DisbandStranded::decode(&wide.to_bytes()), Ok(wide));
        assert_eq!(
            WideCommand::decode(&wide.to_bytes()),
            Ok(WideCommand::DisbandStranded(wide))
        );
    }
}

#[test]
fn stranded_table_requires_nine_exact_positions() {
    assert_eq!(bounds_in(DISBAND_STRANDED), (9, 9));
    assert_eq!(DISBAND_STRANDED.len(), 1);
    let specs = DISBAND_STRANDED[0].specs;
    let expected = [
        ("any", Acc::Wallet, true, Wr::R),
        ("season", Acc::Kind(AccountKind::Season), false, Wr::R),
        ("province", Acc::Any, false, Wr::W),
        ("roster", Acc::Any, false, Wr::W),
        ("holding", Acc::Any, false, Wr::R),
        ("transit", Acc::Any, false, Wr::R),
        ("transit", Acc::Any, false, Wr::R),
        ("transit", Acc::Any, false, Wr::R),
        ("transit", Acc::Any, false, Wr::R),
    ];
    for (spec, (name, acc, signer, wr)) in specs.iter().zip(expected) {
        assert_eq!(
            (spec.name, spec.acc, spec.signer, spec.wr),
            (name, acc, signer, wr)
        );
    }
    assert_eq!(DISBAND_STRANDED_TRANSIT0, 5);
    assert_eq!(position_in(DISBAND_STRANDED, 9, "holding", 0), Some(4));
    for i in 0..4 {
        assert_eq!(position_in(DISBAND_STRANDED, 9, "transit", i), Some(5 + i));
    }
    for count in [4, 5, 8, 10] {
        assert_eq!(position_in(DISBAND_STRANDED, count, "holding", 0), None);
    }
}

#[test]
fn malformed_envelopes_and_adjacent_close_commands_stay_distinct() {
    let bytes = DisbandStranded { entry: 55 }.to_bytes();
    for n in 0..bytes.len() {
        assert_eq!(
            DisbandStranded::decode(&bytes[..n]),
            Err(FrontierError::BadData)
        );
        assert_eq!(
            WideCommand::decode(&bytes[..n]),
            Err(FrontierError::BadData)
        );
    }
    let mut extra = bytes.to_vec();
    extra.push(0);
    assert_eq!(DisbandStranded::decode(&extra), Err(FrontierError::BadData));
    assert_eq!(WideCommand::decode(&extra), Err(FrontierError::BadData));
    for (at, replacement) in [
        (0, 0xda),
        (0, 0xdc),
        (0, 0xdf),
        (0, 0xee),
        (0, 0x48),
        (1, 0),
        (1, 1),
        (2, 0),
        (2, 2),
        (3, 0),
        (3, 1),
        (3, 3),
        (3, 255),
    ] {
        let mut bad = bytes;
        bad[at] = replacement;
        assert_eq!(DisbandStranded::decode(&bad), Err(FrontierError::BadData));
        assert_eq!(WideCommand::decode(&bad), Err(FrontierError::BadData));
    }
    for what in 0..=CLOSE_WHAT_MAX {
        let close = Close { what };
        assert_eq!(
            WideCommand::decode(&close.to_bytes()),
            Ok(WideCommand::Close(close))
        );
        assert_eq!(
            DisbandStranded::decode(&close.to_bytes()),
            Err(FrontierError::BadData)
        );
    }
    assert_eq!(
        WideCommand::decode(&CloseRoster.to_bytes()),
        Ok(WideCommand::CloseRoster(CloseRoster))
    );
    assert_eq!(
        DisbandStranded::decode(&CloseRoster.to_bytes()),
        Err(FrontierError::BadData)
    );
    assert_eq!(CloseRoster::decode(&bytes), Err(FrontierError::BadData));
    assert_eq!(Close::decode(&bytes), Err(FrontierError::BadData));
    let legacy = frontier_abi::ix::DisbandStranded { entry: 55 }.to_bytes();
    assert_eq!(WideCommand::decode(&legacy), Err(FrontierError::BadData));
}
