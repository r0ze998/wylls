//! Provisional host-only ABI contract; synthetic public bytes, no signing.
#![cfg(feature = "world-index-experimental")]

use frontier_abi::error::FrontierError;
use frontier_abi::prologue::{bounds_in, Wr};
use frontier_abi::tags::Class;
use frontier_abi::world_index::event::*;
use frontier_abi::world_index::wide_ix::{
    Garrison, ResidentAct, WideCommand, GARRISON, OP_GARRISON,
};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};

fn holding() -> WideHostRef {
    WideHostRef::new(
        ProvinceKey::new(
            WorldId::new([7; 32]).unwrap(),
            WideCoord::checked(129, 0).unwrap(),
        ),
        0,
        1,
        0,
    )
    .unwrap()
}

fn receipt() -> GarrisonReceipt {
    GarrisonReceipt {
        delta: 12,
        now_ts: 123,
        became_final: true,
        input_digest: [1; 32],
        output_digest: [2; 32],
    }
}

#[test]
fn envelope_is_exact_and_resident_eligible() {
    assert_eq!(OP_GARRISON, 4);
    for delta in [1, u32::MAX as i64] {
        let value = Garrison { delta };
        let bytes = value.to_bytes().unwrap();
        assert_eq!(&bytes[..4], &[0xda, 0xff, 1, 4]);
        assert_eq!(bytes.len(), 12);
        assert_eq!(Garrison::decode(&bytes), Ok(value));
        let command = WideCommand::decode(&bytes).unwrap();
        assert_eq!(command, WideCommand::Garrison(value));
        assert_eq!(command.class(), Class::P);
        assert!(command.is_player());
        assert!(!command.top_level_only());
        assert!(!command.march_stage());
        assert_eq!(command.name(), "WideGarrison");
        let mut wrapped = [0; 17];
        let act = ResidentAct {
            generation: 3,
            inner: &bytes,
        };
        assert_eq!(act.encode_into(&mut wrapped), Some(17));
        assert_eq!(
            ResidentAct::decode(&wrapped).unwrap().command(),
            Ok(command)
        );
        for n in 0..bytes.len() {
            assert!(WideCommand::decode(&bytes[..n]).is_err());
        }
        let mut extra = bytes.to_vec();
        extra.push(0);
        assert!(WideCommand::decode(&extra).is_err());
        for (at, bad) in [(0, 0xdc), (1, 0), (2, 2), (3, 255)] {
            let mut corrupt = bytes;
            corrupt[at] = bad;
            assert!(WideCommand::decode(&corrupt).is_err());
        }
        assert!(frontier_abi::v2::ix::tag_of(&bytes).is_err());
    }
    for delta in [i64::MIN, -1, 0, u32::MAX as i64 + 1, i64::MAX] {
        assert!(Garrison { delta }.to_bytes().is_none());
        let mut bytes = [0xda, 0xff, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0];
        bytes[4..].copy_from_slice(&delta.to_le_bytes());
        assert_eq!(Garrison::decode(&bytes), Err(FrontierError::BadData));
    }
    assert_eq!(bounds_in(GARRISON), (6, 6));
    assert_eq!(GARRISON[0].specs[4].wr, Wr::W);
    assert_eq!(GARRISON[0].specs[5].wr, Wr::W);
}

#[test]
fn receipt_is_canonical_and_links_both_full_identities() {
    let receipt = receipt();
    let payload = garrison_payload(&receipt).unwrap();
    assert_eq!(payload.len(), 82);
    assert_eq!(GarrisonReceipt::decode(&payload), Ok(receipt));
    for n in 0..payload.len() {
        assert!(GarrisonReceipt::decode(&payload[..n]).is_err());
    }
    let mut extra = payload.to_vec();
    extra.push(0);
    assert!(GarrisonReceipt::decode(&extra).is_err());
    for (at, bad) in [(0, 2), (17, 2)] {
        let mut corrupt = payload;
        corrupt[at] = bad;
        assert!(GarrisonReceipt::decode(&corrupt).is_err());
    }
    for delta in [-1, 0, u32::MAX as i64 + 1] {
        assert!(GarrisonReceipt { delta, ..receipt }.to_bytes().is_none());
        let mut corrupt = payload;
        corrupt[1..9].copy_from_slice(&delta.to_le_bytes());
        assert!(GarrisonReceipt::decode(&corrupt).is_err());
    }
    let h = holding();
    let key = h.to_bytes();
    let kind = WideKind::Garrison;
    assert_eq!(kind as u8, 17);
    assert!(!kind.host_keyed());
    assert!(kind.holding_keyed());
    assert_eq!(kind.links(), &[WideEntity::Province, WideEntity::Holding]);
    let mut body = [0; MAX_BODY];
    let n = write_body(kind, 9, &key, &payload, &mut body).unwrap();
    let links: Vec<_> = kind
        .links()
        .iter()
        .map(|e| advance(*e, 0, &[0; 32], &body[..n]).unwrap())
        .collect();
    let encoded = encode(kind, 9, &key, &payload, &links).unwrap();
    let record = WideRecord::decode(&encoded).unwrap();
    assert_eq!(record.receipt(), None);
    assert_eq!(record.garrison_receipt(), Some(receipt));
    assert!(record.host().is_none());
    assert_eq!(record.holding_of(), Some(h));
    assert_eq!(record.province_of(), Some(h.key()));
    assert!(encode(kind, 9, &key, &payload, &links[..1]).is_none());
    let host = WideHostRef::new(h.key(), h.site(), h.gen(), 1).unwrap();
    assert!(write_body(kind, 9, &host.to_bytes(), &payload, &mut body).is_none());
    assert!(write_body(WideKind::EconomyMirror, 9, &key, &payload, &mut body).is_none());
    for (target, link) in [
        (WideTarget::Province(h.key()), links[0]),
        (WideTarget::Holding(h), links[1]),
    ] {
        assert_eq!(
            verify_chain(target, (0, [0; 32]), [encoded.as_slice()]),
            Ok((1, link.head))
        );
    }
    let mut corrupt = encoded;
    corrupt[HEAD_LEN + HOLDING_KEY_LEN + 17] = 2;
    assert_eq!(WideRecord::decode(&corrupt), Err(EventError::Payload));
}

#[test]
fn digests_bind_full_snapshots_and_normalize_only_output_chains() {
    use frontier_abi::layout::header;
    use frontier_abi::world_index::economy::{self, Snapshots};
    use frontier_abi::world_index::holding::{wide_holding, WideHolding};
    use frontier_abi::world_index::land::{self, WideProvince};
    use frontier_abi::world_index::Decision;
    let h = holding();
    let identity = WideHolding::found(
        h.key().world(),
        11,
        h.key().coord(),
        h.site(),
        h.gen(),
        2,
        [9; 32],
        &Decision::Decided(()),
    )
    .unwrap();
    let mut hd = vec![0; wide_holding::SIZE];
    identity.write_identity(&mut hd).unwrap();
    let province = WideProvince {
        season_id: 11,
        world: h.key().world(),
        coord: h.key().coord(),
        wedge: h.key().coord().wedge().unwrap(),
        region: 0,
        opened_bell: 0,
        readiness: land::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [1; 32],
        funded_lamports: 0,
    };
    let mut pd = vec![0; land::province::SIZE];
    province.write_identity(&mut pd).unwrap();
    let cd = vec![0; frontier_abi::v2::layout::player::citizen::SIZE];
    let before = Snapshots {
        citizen: &cd,
        holding: &hd,
        province: &pd,
    };
    let input = garrison_input_digest(&h, 12, 123, &[7; 64], &before).unwrap();
    let output = garrison_output_digest(&h, 12, 123, false, &before).unwrap();
    assert_ne!(input, output);
    assert_ne!(
        input,
        garrison_input_digest(&h, 13, 123, &[7; 64], &before).unwrap()
    );
    assert_ne!(
        input,
        garrison_input_digest(&h, 12, 124, &[7; 64], &before).unwrap()
    );
    assert_ne!(
        input,
        garrison_input_digest(&h, 12, 123, &[8; 64], &before).unwrap()
    );
    assert_ne!(
        output,
        garrison_output_digest(&h, 12, 123, true, &before).unwrap()
    );
    assert_ne!(
        input,
        economy::input_digest(&h, economy::Action::Harvest, 123, &[7; 64], &before).unwrap()
    );
    let mut changed_cd = cd.clone();
    changed_cd[100] ^= 1;
    let changed = Snapshots {
        citizen: &changed_cd,
        ..before
    };
    assert_ne!(
        input,
        garrison_input_digest(&h, 12, 123, &[7; 64], &changed).unwrap()
    );
    assert_ne!(
        output,
        garrison_output_digest(&h, 12, 123, false, &changed).unwrap()
    );
    let mut chain_hd = hd.clone();
    chain_hd[header::EVENT_SEQ] = 1;
    chain_hd[header::EVENT_HEAD] = 8;
    let mut chain_pd = pd.clone();
    chain_pd[header::EVENT_SEQ] = 1;
    chain_pd[header::EVENT_HEAD] = 9;
    let changed = Snapshots {
        holding: &chain_hd,
        province: &chain_pd,
        ..before
    };
    assert_ne!(
        input,
        garrison_input_digest(&h, 12, 123, &[7; 64], &changed).unwrap()
    );
    assert_eq!(
        output,
        garrison_output_digest(&h, 12, 123, false, &changed).unwrap()
    );
    assert!(garrison_input_digest(&h, 0, 123, &[7; 64], &before).is_err());
    assert!(garrison_output_digest(&h, -1, 123, false, &before).is_err());
    let malformed = Snapshots {
        holding: &[],
        ..before
    };
    assert!(garrison_input_digest(&h, 12, 123, &[7; 64], &malformed).is_err());
    let host = WideHostRef::new(h.key(), h.site(), h.gen(), 1).unwrap();
    assert!(garrison_input_digest(&host, 12, 123, &[7; 64], &before).is_err());
}
