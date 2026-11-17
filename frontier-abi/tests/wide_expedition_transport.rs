//! Public literal identities and pure codecs/hashes only. No IO or signing.
#![cfg(feature = "world-index-experimental")]
use frontier_abi::{
    addr::{self, AddrCtx},
    world_index::{
        arrival::{wide_arrival_slot as S, WideArrivalSlot},
        expedition::AccountResolver,
        expedition_bridge::{BridgeMarker, BridgeTransit, VERSION as MARKER_VERSION},
        expedition_transport::*,
        march::{MarchState, WideTransit},
        ProvinceKey, TileAddress, WideCoord, WideHostRef, HOST_IDENTITY_FULL_REF_V1,
    },
};
use permutation_rules::{frontier::structure::wear, hash::sha256};
fn ctx() -> AddrCtx {
    AddrCtx {
        season: [11; 32],
        program: [12; 32],
    }
}
fn settled_stamina() -> u16 {
    use permutation_rules::frontier::{
        host::STAMINA_CAP,
        travel::{march_stamina, MAX_PATH_STEPS},
    };
    STAMINA_CAP - march_stamina(MAX_PATH_STEPS as u32)
}
fn fixture() -> (OwnedBridgeTransit, WideArrivalSlot) {
    use permutation_rules::frontier::{
        doctrine::of_faction_v3,
        stance::{Posture, Stance},
        travel::{march_stamina, MAX_PATH_STEPS},
    };
    let doctrine = of_faction_v3(2).unwrap();
    let dealt = doctrine.dealt_bps(Posture::Stance(Stance::Hold), true) as u16;
    let c = ctx();
    let r = AccountResolver::for_season(&c).unwrap();
    let host = r
        .legacy_host_ref(addr::host_id(128, 0, 2, 1, 0).unwrap())
        .unwrap();
    let t = WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        host,
        doctrine.unit as u8,
        2,
        TileAddress::new(host.key(), 3).unwrap(),
        10,
        12,
        600,
        100_000,
        march_stamina(MAX_PATH_STEPS as u32),
        dealt,
        [21; 32],
        0,
        0,
        [22; 32],
    )
    .unwrap();
    let b = OwnedBridgeTransit::new(&c, 2, t, [23; 32]).unwrap();
    let s = WideArrivalSlot {
        season_id: 11,
        dest: ProvinceKey::new(r.adapter().world(), WideCoord::checked(129, 0).unwrap()),
        bell: 12,
        faction: 2,
        i: 1,
        transit_slot: 2,
        host,
        citizen: [23; 32],
        unit: doctrine.unit as u8,
        stance: frontier_abi::world_index::arrival::stance_byte(Stance::Hold),
        tile: 30,
        retreat_bps: 0,
        dealt_bps: dealt,
        dep_mass: 100_000,
        flags: 0,
        beneficiary: [24; 32],
        rent_to: [25; 32],
        ev_slot: 5000,
        ev_price: 7,
        ev_limit: 26_000,
        ev_loaded: 1 << 20,
        claimed: false,
    };
    (b, s)
}

#[test]
fn explicit_bridge_v2_retains_v1_marker_without_owner_invention() {
    let (b, _) = fixture();
    let bytes = b.to_bytes();
    assert_eq!(bytes.len(), 336);
    assert_eq!(bytes[8], 2);
    assert_eq!(&bytes[304..], &b.original_owner());
    assert_eq!(OwnedBridgeTransit::from_bytes(&ctx(), &bytes), Ok(b));
    assert!(BridgeTransit::from_bytes(&ctx(), &bytes).is_err());
    assert!(OwnedBridgeTransit::from_bytes(&ctx(), &b.common().to_bytes()).is_err());
    assert!(OwnedBridgeTransit::new(&ctx(), 2, b.transit(), [0; 32]).is_err());
    let marker = BridgeMarker::new(&ctx(), b.common(), 7, 0).unwrap();
    assert_eq!(MARKER_VERSION, 1);
    assert_eq!(marker.to_bytes()[93], 1);
    assert_eq!(
        BridgeMarker::from_bytes(&ctx(), &marker.to_bytes()),
        Ok(marker)
    );
    for end in 0..bytes.len() {
        assert!(OwnedBridgeTransit::from_bytes(&ctx(), &bytes[..end]).is_err());
    }
    let mut extra = bytes.to_vec();
    extra.push(0);
    assert!(OwnedBridgeTransit::from_bytes(&ctx(), &extra).is_err());
    for off in [0, 8, 9, 10, 15, 16, 16 + 115, 16 + 166, 16 + 287] {
        let mut bad = bytes;
        bad[off] = 255;
        assert!(
            OwnedBridgeTransit::from_bytes(&ctx(), &bad).is_err(),
            "offset {off}"
        );
    }
    let mut bad = bytes;
    bad[304..].fill(0);
    assert_eq!(
        OwnedBridgeTransit::from_bytes(&ctx(), &bad),
        Err(Error::Owner)
    );
    // A different nonzero owner is structurally representable, not authorized:
    // full bytes/receipt binding and authenticated creation detect substitution.
    let mut changed = bytes;
    changed[304] ^= 1;
    assert_ne!(sha256(&[&bytes]), sha256(&[&changed]));
    assert_ne!(
        OwnedBridgeTransit::from_bytes(&ctx(), &changed)
            .unwrap()
            .original_owner(),
        b.original_owner()
    );
}

#[test]
fn expedition_slot_v2_is_exact_and_old_reader_always_rejects() {
    let (_, common) = fixture();
    for worn in [0, 1, 3000] {
        let s = ExpeditionArrivalSlot::new(&ctx(), common, worn).unwrap();
        let bytes = s.to_bytes(&ctx()).unwrap();
        assert_eq!(bytes.len(), 288);
        assert_eq!(&bytes[16..18], &[2, 0]);
        assert_eq!(&bytes[188..190], &worn.to_le_bytes());
        assert_eq!(&bytes[190..192], &[0, 0]);
        assert_eq!(ExpeditionArrivalSlot::read(&ctx(), &bytes), Ok(s));
        assert!(WideArrivalSlot::read(&bytes).is_err());
        for end in 0..bytes.len() {
            assert!(ExpeditionArrivalSlot::read(&ctx(), &bytes[..end]).is_err());
        }
        let mut extra = bytes.to_vec();
        extra.push(0);
        assert!(ExpeditionArrivalSlot::read(&ctx(), &extra).is_err());
        for off in [0, 16, 17, 29, 31, 36, 39, 89, 95, 190, 191, 281, 287] {
            let mut bad = bytes;
            bad[off] = 255;
            assert!(
                ExpeditionArrivalSlot::read(&ctx(), &bad).is_err(),
                "offset {off}"
            );
        }
        for (offset, invalid) in [
            (S::FLAGS, 255),
            (S::TRANSIT_SLOT, 4),
            (S::FACTION, 6),
            (S::I, 4),
            (S::UNIT, 255),
            (S::CLAIMED, 2),
        ] {
            let mut bad = bytes;
            bad[offset] = invalid;
            assert!(ExpeditionArrivalSlot::read(&ctx(), &bad).is_err());
        }
    }
    assert_eq!(
        ExpeditionArrivalSlot::new(&ctx(), common, 3001),
        Err(Error::Wear)
    );
    let mut bad = ExpeditionArrivalSlot::new(&ctx(), common, 0)
        .unwrap()
        .to_bytes(&ctx())
        .unwrap();
    bad[188..190].copy_from_slice(&3001u16.to_le_bytes());
    assert_eq!(ExpeditionArrivalSlot::read(&ctx(), &bad), Err(Error::Wear));
    let mut old = [0; S::SIZE];
    common.write(&mut old).unwrap();
    assert!(ExpeditionArrivalSlot::read(&ctx(), &old).is_err());
    assert!(
        ArrivalSlot::read(&ctx(), &old).is_err(),
        "legacy host is not silently admitted as native v1"
    );
}

#[test]
fn explicit_mixed_reader_preserves_variants_rent_quota_evidence_and_wear() {
    let (_, common) = fixture();
    let expedition = ExpeditionArrivalSlot::new(&ctx(), common, 3000).unwrap();
    let mut native = common;
    native.host = WideHostRef::new(common.dest, 2, 1, 7).unwrap();
    assert_eq!(
        ExpeditionArrivalSlot::new(&ctx(), native, 0),
        Err(Error::Family)
    );
    for slot in [
        ArrivalSlot::Native(native),
        ArrivalSlot::Expedition(expedition),
    ] {
        let bytes = slot.to_bytes(&ctx()).unwrap();
        let decoded = ArrivalSlot::read(&ctx(), &bytes).unwrap();
        assert_eq!(decoded, slot);
        let rewritten = decoded.with_claimed(true).with_settled();
        let changed = rewritten.to_bytes(&ctx()).unwrap();
        assert_eq!(&changed[16..18], &bytes[16..18]);
        assert_eq!(&changed[188..192], &bytes[188..192]);
        assert_eq!(rewritten.worn_bps(), slot.worn_bps());
        assert_eq!(rewritten.common().dep_mass, common.dep_mass);
        assert_eq!(rewritten.common().citizen, common.citizen);
        assert_eq!(rewritten.common().rent_to, common.rent_to);
        assert_eq!(rewritten.common().ev_slot, common.ev_slot);
        assert_eq!(rewritten.common().ev_loaded, common.ev_loaded);
        assert_eq!(ArrivalSlot::read(&ctx(), &changed), Ok(rewritten));
    }
    for i in 0..4 {
        let s = ExpeditionArrivalSlot::new(&ctx(), WideArrivalSlot { i, ..common }, 3000).unwrap();
        assert_eq!(s.common().i, i);
    }
}

#[test]
fn owner_and_wear_survive_origin_and_repeat_gather_without_changing_quota() {
    let (b, common) = fixture();
    let s = ExpeditionArrivalSlot::new(&ctx(), common, 3000).unwrap();
    assert_eq!(b.gather_worn(&ctx(), &s), Err(Error::State));
    let settled = b
        .settle_origin(&ctx(), false, Some((80_000, settled_stamina(), 2)))
        .unwrap();
    assert_eq!(settled.original_owner(), b.original_owner());
    assert_eq!(
        settled.gather_worn(&ctx(), &s.with_settled()),
        Err(Error::Pair)
    );
    assert!(
        OwnedBridgeTransit::new(&ctx(), 2, settled.transit(), b.original_owner()).is_err(),
        "new cannot promote settled historical state"
    );
    let gathered = settled.gather_worn(&ctx(), &s).unwrap();
    assert_eq!(gathered.transit().troops_after, wear(80_000, 3000) as u32);
    assert_eq!(gathered.transit().troops_after, 56_000);
    assert_eq!(gathered.transit().dep_mass, 100_000);
    assert_eq!(gathered.transit().stamina_after, settled_stamina());
    assert_eq!(gathered.transit().dealt_bps, b.transit().dealt_bps);
    assert_eq!(gathered.original_owner(), b.original_owner());
    assert_eq!(gathered.transit().state, MarchState::Gathered);
    assert_eq!(gathered.gather_worn(&ctx(), &s), Ok(gathered));
    assert_eq!(
        OwnedBridgeTransit::from_bytes(&ctx(), &gathered.to_bytes()),
        Ok(gathered)
    );
    let other_dest = ProvinceKey::new(common.dest.world(), WideCoord::checked(130, 0).unwrap());
    let other = ExpeditionArrivalSlot::new(
        &ctx(),
        WideArrivalSlot {
            dest: other_dest,
            ..common
        },
        3000,
    )
    .unwrap();
    assert_eq!(gathered.gather_worn(&ctx(), &other), Err(Error::State));
    let captor = ExpeditionArrivalSlot::new(
        &ctx(),
        WideArrivalSlot {
            citizen: [99; 32],
            ..common
        },
        3000,
    )
    .unwrap();
    assert_eq!(settled.gather_worn(&ctx(), &captor), Err(Error::Pair));
    let wrong_mass = ExpeditionArrivalSlot::new(
        &ctx(),
        WideArrivalSlot {
            dep_mass: common.dep_mass + 1,
            ..common
        },
        3000,
    )
    .unwrap();
    assert_eq!(settled.gather_worn(&ctx(), &wrong_mass), Err(Error::Pair));
    let destroyed = b
        .settle_origin(&ctx(), true, Some((0, 0, 2)))
        .unwrap()
        .gather_worn(&ctx(), &s)
        .unwrap();
    assert_eq!(destroyed.transit().troops_after, 0);
    assert_eq!(destroyed.original_owner(), b.original_owner());
    let tiny = b
        .settle_origin(&ctx(), false, Some((1, settled_stamina(), 2)))
        .unwrap()
        .gather_worn(&ctx(), &s)
        .unwrap();
    assert_eq!(tiny.transit().troops_after, wear(1, 3000) as u32);
    for (before, after) in [(712, 499), (713, 500)] {
        let result = b
            .settle_origin(&ctx(), false, Some((before, settled_stamina(), 2)))
            .unwrap()
            .gather_worn(&ctx(), &s)
            .unwrap();
        assert_eq!(result.transit().troops_after, after);
        assert_eq!(result.gather_worn(&ctx(), &s), Ok(result));
        // Transport preserves the exact boundary; destination population/fate
        // remains a separately reviewed runtime operation.
        assert_eq!(
            after >= permutation_rules::frontier::host::DESTROYED_BELOW,
            before == 713
        );
    }
    assert_eq!(destroyed.gather_worn(&ctx(), &s), Ok(destroyed));
}

#[test]
fn every_reserved_byte_and_wrong_context_family_are_rejected() {
    let (b, common) = fixture();
    let bytes = b.to_bytes();
    for off in (10..16)
        .chain([16 + 115])
        .chain(16 + 166..16 + 168)
        .chain(16 + 272..16 + 288)
    {
        let mut bad = bytes;
        bad[off] = 1;
        assert!(
            OwnedBridgeTransit::from_bytes(&ctx(), &bad).is_err(),
            "bridge reserved {off}"
        );
    }
    let s = ExpeditionArrivalSlot::new(&ctx(), common, 3000).unwrap();
    let bytes = s.to_bytes(&ctx()).unwrap();
    for off in (29..32)
        .chain(36..40)
        .chain(89..96)
        .chain(190..192)
        .chain(281..288)
    {
        let mut bad = bytes;
        bad[off] = 1;
        assert!(
            ExpeditionArrivalSlot::read(&ctx(), &bad).is_err(),
            "slot reserved {off}"
        );
    }
    for wrong in [
        AddrCtx {
            season: [99; 32],
            program: ctx().program,
        },
        AddrCtx {
            program: [99; 32],
            season: ctx().season,
        },
    ] {
        assert!(OwnedBridgeTransit::from_bytes(&wrong, &b.to_bytes()).is_err());
        assert!(ExpeditionArrivalSlot::read(&wrong, &bytes).is_err());
        assert!(ArrivalSlot::read(&wrong, &bytes).is_err());
    }
    let native_host = WideHostRef::new(common.dest, 2, 1, 0).unwrap();
    let mut wrong_transit = b.transit();
    wrong_transit.host = native_host;
    assert!(OwnedBridgeTransit::new(&ctx(), b.slot(), wrong_transit, b.original_owner()).is_err());
    let mut free = b.transit();
    free.state = MarchState::Free;
    assert_eq!(
        OwnedBridgeTransit::new(&ctx(), b.slot(), free, b.original_owner()),
        Err(Error::State)
    );
    assert_eq!(
        ExpeditionArrivalSlot::new(
            &ctx(),
            WideArrivalSlot {
                dest: common.host.key(),
                ..common
            },
            0
        ),
        Err(Error::Family)
    );
    assert_eq!(
        ExpeditionArrivalSlot::new(
            &ctx(),
            WideArrivalSlot {
                citizen: [0; 32],
                ..common
            },
            0
        ),
        Err(Error::Owner)
    );
    let plain = ArrivalSlot::Native(WideArrivalSlot {
        host: native_host,
        ..common
    });
    let mut native_bytes = plain.to_bytes(&ctx()).unwrap();
    native_bytes[188] = 1;
    assert!(
        ArrivalSlot::read(&ctx(), &native_bytes).is_err(),
        "v1 reserved wear must stay zero"
    );
}

#[test]
fn arrival_drilled_stance_multiplier_need_not_equal_departure_hold() {
    use permutation_rules::frontier::{
        doctrine::of_faction_v3,
        stance::{Posture, Stance},
    };
    let (b, common) = fixture();
    let doctrine = of_faction_v3(common.faction).unwrap();
    let departure = doctrine.dealt_bps(Posture::Stance(Stance::Hold), true) as u16;
    let arriving = doctrine.dealt_bps(Posture::Stance(Stance::Assault), true) as u16;
    assert_eq!(departure, 10_500);
    assert_eq!(arriving, 11_025);
    assert_ne!(departure, arriving);
    assert_eq!(b.transit().dealt_bps, departure);
    let s = ExpeditionArrivalSlot::new(
        &ctx(),
        WideArrivalSlot {
            stance: frontier_abi::world_index::arrival::stance_byte(Stance::Assault),
            dealt_bps: arriving,
            ..common
        },
        3000,
    )
    .unwrap();
    let settled = b
        .settle_origin(&ctx(), false, Some((80_000, settled_stamina(), 2)))
        .unwrap();
    let gathered = settled.gather_worn(&ctx(), &s).unwrap();
    assert_eq!(gathered.transit().troops_after, 56_000);
    assert_eq!(
        gathered.transit().dealt_bps,
        departure,
        "departure evidence stays immutable"
    );
    assert_eq!(
        s.common().dealt_bps,
        arriving,
        "arrival record uses authenticated revealed stance"
    );
    assert_eq!(gathered.gather_worn(&ctx(), &s), Ok(gathered));
}
