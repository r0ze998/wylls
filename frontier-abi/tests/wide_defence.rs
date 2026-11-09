//! Host-only provisional codecs and recorded refund evidence. No signing.
#![cfg(feature = "world-index-experimental")]

use frontier_abi::error::FrontierError;
use frontier_abi::layout::AccountKind;
use frontier_abi::prologue::{bounds_in, counts_in, resolve_in, Acc, Wr};
use frontier_abi::tags::Class;
use frontier_abi::world_index::arrival::{wide_arrival_slot as L, WideArrivalSlot};
use frontier_abi::world_index::wide_ix::*;
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};

#[test]
fn literal_claim_codec_and_class_d_refusal() {
    assert_eq!(OP_CLAIM_DEFENCE, 6);
    assert_eq!(ClaimDefence::LEN, 9);
    assert_eq!(ClaimDefence::MAX_SLOTS, 6);
    for n in 1..=6 {
        let value = ClaimDefence { day: 0x12345678, n };
        let bytes = [0xdc, 0xff, 1, 6, 0x78, 0x56, 0x34, 0x12, n];
        assert_eq!(value.to_bytes(), Some(bytes));
        assert_eq!(ClaimDefence::decode(&bytes), Ok(value));
        let command = WideCommand::decode(&bytes).unwrap();
        assert_eq!(command, WideCommand::ClaimDefence(value));
        assert_eq!(command.name(), "WideClaimDefence");
        assert_eq!(command.class(), Class::D);
        assert!(!command.is_player());
        assert!(!command.top_level_only());
        assert!(!command.march_stage());
        assert_eq!(command.accounts(), CLAIM_DEFENCE);
        assert!(frontier_abi::v2::ix::tag_of(&bytes).is_err());
        let mut wrapped = [0; 14];
        ResidentAct {
            generation: 1,
            inner: &bytes,
        }
        .encode_into(&mut wrapped)
        .unwrap();
        assert_eq!(ResidentAct::decode(&wrapped), Err(FrontierError::BadData));
        assert_eq!(WideCommand::decode(&wrapped), Err(FrontierError::BadData));
        for len in 0..bytes.len() {
            assert!(ClaimDefence::decode(&bytes[..len]).is_err());
            // Two bytes still represent the unchanged legacy SettleTicket.
            if len != SettleTicket::LEN {
                assert!(WideCommand::decode(&bytes[..len]).is_err());
            }
        }
        let mut extra = bytes.to_vec();
        extra.push(0);
        assert!(WideCommand::decode(&extra).is_err());
        for (offset, invalid) in [(0, 0xda), (1, 0), (2, 2), (3, 255)] {
            let mut bad = bytes;
            bad[offset] = invalid;
            assert!(ClaimDefence::decode(&bad).is_err());
            assert!(WideCommand::decode(&bad).is_err());
        }
    }
    for n in [0, 7, 255] {
        assert!(ClaimDefence { day: 0, n }.to_bytes().is_none());
        assert!(WideCommand::decode(&[0xdc, 0xff, 1, 6, 0, 0, 0, 0, n]).is_err());
    }
    for day in [0, u32::MAX] {
        let value = ClaimDefence { day, n: 1 };
        assert_eq!(ClaimDefence::decode(&value.to_bytes().unwrap()), Ok(value));
    }
    assert_eq!(
        [
            OP_RESOLVE,
            OP_RETURN,
            OP_SETTLE_DEPARTURE,
            OP_GATHER,
            OP_SETTLE_TRANSIT
        ],
        [1, 2, 3, 4, 5]
    );
    assert_eq!(
        WideCommand::decode(&[0xdc, 0]),
        Ok(WideCommand::SettleTicket(SettleTicket { k: 0 }))
    );
}

#[test]
fn shared_accounts_and_exact_pair_counts() {
    assert_eq!(bounds_in(CLAIM_DEFENCE), (7, 17));
    let fixed = CLAIM_DEFENCE[0].specs;
    assert_eq!(fixed.len(), 5);
    assert!(fixed[0].signer);
    assert_eq!(fixed[0].acc, Acc::Wallet);
    assert_eq!(fixed[1].acc, Acc::Kind(AccountKind::Season));
    assert_eq!(fixed[2].acc, Acc::Kind(AccountKind::DefencePool));
    assert_eq!(fixed[3].acc, Acc::Kind(AccountKind::DefenceClaim));
    assert_eq!(fixed[4].acc, Acc::System);
    assert_eq!(
        fixed.iter().map(|s| s.wr).collect::<Vec<_>>(),
        [Wr::W, Wr::R, Wr::W, Wr::W, Wr::R]
    );
    assert!(fixed[1..].iter().all(|s| !s.signer));
    let pair = CLAIM_DEFENCE[1].specs;
    assert_eq!(pair.len(), 2);
    assert_eq!(pair[0].wr, Wr::W);
    assert_eq!(pair[1].wr, Wr::R);
    assert_eq!(pair[1].acc, Acc::Kind(AccountKind::BellAnchor));
    assert!(pair.iter().all(|s| !s.signer));
    for n in 0..=19 {
        let mut counts = [0; 2];
        let valid = (7..=17).contains(&n) && n % 2 == 1;
        assert_eq!(counts_in(CLAIM_DEFENCE, n, &mut counts).is_some(), valid);
        if valid {
            assert_eq!(counts, [1, ((n - 5) / 2) as u8]);
            let mut specs = [fixed[0]; 17];
            assert_eq!(resolve_in(CLAIM_DEFENCE, &counts, &mut specs), Some(n));
        }
    }
}

#[test]
fn evidence_preserves_created_day_across_slot_roundtrip() {
    let dest = ProvinceKey::new(
        WorldId::new([7; 32]).unwrap(),
        WideCoord::checked(130, -1).unwrap(),
    );
    for flags in 0..=L::FLAGS_MASK {
        let slot = WideArrivalSlot {
            season_id: 11,
            dest,
            bell: 40,
            faction: 2,
            i: 1,
            transit_slot: 2,
            host: WideHostRef::new(dest, 0, 1, 0).unwrap(),
            citizen: [1; 32],
            unit: permutation_rules::units::UnitType::Knight as u8,
            stance: 0,
            tile: 30,
            retreat_bps: 0,
            dealt_bps: 10_000,
            dep_mass: 12_000_000,
            flags,
            beneficiary: [2; 32],
            rent_to: [3; 32],
            ev_slot: 5000,
            ev_price: 1234,
            ev_limit: 26000,
            ev_loaded: 1 << 20,
            claimed: false,
        };
        let mut bytes = [0; L::SIZE];
        slot.write(&mut bytes).unwrap();
        let decoded = WideArrivalSlot::read(&bytes).unwrap();
        assert_eq!(decoded, slot);
        let evidence = decoded.evidence();
        assert_eq!(evidence.price_micro, slot.ev_price);
        assert_eq!(evidence.limit, slot.ev_limit);
        assert_eq!(evidence.loaded, slot.ev_loaded);
        assert_eq!(evidence.created_day, flags & L::FLAG_CREATED_DAY != 0);
    }
}
