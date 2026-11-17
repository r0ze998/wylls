#![cfg(feature = "world-index-experimental")]
//! Public literal addresses only. No signing, private keys or native crypto.
use frontier_abi::{
    addr::{self, AddrCtx},
    layout::player::transit as T,
    world_index::{
        expedition::AccountResolver,
        expedition_bridge::*,
        march::{transit_address, MarchEvent, MarchState, WideTransit},
        ProvinceKey, TileAddress, WideCoord, WideHostRef, WorldId, HOST_IDENTITY_FULL_REF_V1,
    },
};

fn ctx() -> AddrCtx {
    AddrCtx {
        season: [11; 32],
        program: [12; 32],
    }
}
fn fixture() -> (BridgeMarker, BridgeTransit, [u8; 32], [u8; 32]) {
    let ctx = ctx();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(addr::host_id(128, 0, 2, 1, 0).unwrap())
        .unwrap();
    let transit = WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        host,
        1,
        2,
        TileAddress::new(host.key(), 3).unwrap(),
        10,
        12,
        600,
        100_000,
        800,
        250,
        [21; 32],
        0,
        0,
        [22; 32],
    )
    .unwrap();
    let bridge = BridgeTransit::new(&ctx, 2, transit).unwrap();
    let marker = BridgeMarker::new(
        &ctx,
        &bridge,
        7,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let holding = resolver.holding_address(&host).unwrap();
    let external = transit_address(&ctx, &holding, 2);
    (marker, bridge, holding, external)
}
fn settled(bridge: &BridgeTransit) -> BridgeTransit {
    bridge
        .step(
            &ctx(),
            MarchEvent::SettleDeparture { destroyed: false },
            Some((80_000, 500, 2)),
        )
        .unwrap()
}

#[test]
fn codecs_are_distinct_canonical_and_keep_original_identity() {
    let (marker, bridge, holding, external) = fixture();
    assert_eq!(marker.to_bytes().len(), 96);
    assert_eq!(bridge.to_bytes().len(), 304);
    assert_eq!(
        BridgeMarker::from_bytes(&ctx(), &marker.to_bytes()),
        Ok(marker)
    );
    assert_eq!(
        BridgeTransit::from_bytes(&ctx(), &bridge.to_bytes()),
        Ok(bridge)
    );
    assert!(WideTransit::from_bytes(&bridge.to_bytes()).is_err());
    assert_eq!(
        BridgeTransit::from_bytes(&ctx(), &bridge.transit().to_bytes()),
        Err(BridgeError::Length)
    );
    assert_eq!(bridge.transit().host.seq(), 0);
    assert!(authenticate_pair(&ctx(), &holding, 2, &external, &marker, &bridge).is_ok());
    for state in 0..=3 {
        let mut bytes = marker.to_bytes();
        bytes[0] = state;
        assert_eq!(
            BridgeMarker::from_bytes(&ctx(), &bytes),
            Err(BridgeError::State)
        );
        assert_eq!(T::in_transit(state), state != 0);
    }
    assert!(
        !T::in_transit(MARKER_STATE),
        "codec does not silently change legacy consumers"
    );
}

#[test]
fn unknown_versions_reserved_bytes_and_external_money_are_rejected() {
    let (marker, bridge, _, _) = fixture();
    for offset in [0, 8, 10, 15] {
        let mut bytes = bridge.to_bytes();
        bytes[offset] ^= 0x80;
        assert!(BridgeTransit::from_bytes(&ctx(), &bytes).is_err());
    }
    for offset in [
        T::RSV_93,
        94,
        95,
        T::DEST_P,
        T::DEST_Q,
        T::TROOPS_AFTER,
        T::STAMINA_AFTER,
        T::READY_BELL_OFF,
    ] {
        let mut bytes = marker.to_bytes();
        bytes[offset] ^= 0x80;
        assert!(BridgeMarker::from_bytes(&ctx(), &bytes).is_err());
    }
    let mut t = bridge.transit();
    t.tip = 1;
    assert_eq!(
        BridgeTransit::new(&ctx(), 2, t),
        Err(BridgeError::FinancialAuthority)
    );
    for flag in [T::FLAG_FEE_ESCROWED, T::FLAG_BOND_ESCROWED, 8, 128] {
        let mut t = bridge.transit();
        t.flags = flag;
        assert_eq!(
            BridgeTransit::new(&ctx(), 2, t),
            Err(BridgeError::FinancialAuthority)
        );
        let mut bytes = bridge.to_bytes();
        bytes[16 + 6] = flag;
        assert!(BridgeTransit::from_bytes(&ctx(), &bytes).is_err());
    }
    let mut bytes = marker.to_bytes();
    bytes[T::FLAGS] = T::FLAG_GATHERED;
    assert_eq!(
        BridgeMarker::from_bytes(&ctx(), &bytes),
        Err(BridgeError::FinancialAuthority)
    );
    assert!(BridgeMarker::from_bytes(&ctx(), &marker.to_bytes()[..95]).is_err());
    assert!(BridgeTransit::from_bytes(&ctx(), &bridge.to_bytes()[..303]).is_err());
}

#[test]
fn pair_rejects_wrong_slot_home_account_and_departure_metadata() {
    let (marker, bridge, holding, external) = fixture();
    assert!(authenticate_pair(&ctx(), &holding, 1, &external, &marker, &bridge).is_err());
    assert!(authenticate_pair(&ctx(), &[99; 32], 2, &external, &marker, &bridge).is_err());
    assert!(authenticate_pair(&ctx(), &holding, 2, &[99; 32], &marker, &bridge).is_err());
    assert!(BridgeTransit::new(&ctx(), 4, bridge.transit()).is_err());
    for field in 0..12 {
        let mut t = bridge.transit();
        match field {
            0 => t.dep_mass += 1,
            1 => t.march_stamina += 1,
            2 => t.dealt_bps += 1,
            3 => t.seal_root[0] ^= 1,
            4 => t.depart_ts += 1,
            5 => t.arrive_bell += 1,
            6 => {
                t.depart_bell += 1;
                t.arrive_bell += 1;
            }
            7 => t.unit += 1,
            8 => t.faction += 1,
            9 => t.origin = TileAddress::new(t.origin.key(), 4).unwrap(),
            10 => t.host = WideHostRef::new(t.host.key(), t.host.site(), t.host.gen(), 1).unwrap(),
            _ => {
                let key =
                    ProvinceKey::new(t.host.key().world(), WideCoord::checked(127, 0).unwrap());
                t.origin = TileAddress::new(key, 3).unwrap();
            }
        }
        let other = BridgeTransit::new(&ctx(), 2, t).unwrap();
        assert!(
            authenticate_pair(&ctx(), &holding, 2, &external, &marker, &other).is_err(),
            "field {field}"
        );
    }
}

#[test]
fn family_world_time_and_payload_state_are_checked() {
    let (marker, bridge, holding, external) = fixture();
    let wide = ProvinceKey::new(
        bridge.transit().host.key().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    let mut t = bridge.transit();
    t.host = WideHostRef::new(wide, 2, 1, 0).unwrap();
    assert_eq!(BridgeTransit::new(&ctx(), 2, t), Err(BridgeError::Family));
    let mut t = bridge.transit();
    t.origin = TileAddress::new(wide, 3).unwrap();
    assert_eq!(BridgeTransit::new(&ctx(), 2, t), Err(BridgeError::Family));
    let foreign = ProvinceKey::new(
        WorldId::new([99; 32]).unwrap(),
        WideCoord::checked(128, 0).unwrap(),
    );
    let mut t = bridge.transit();
    t.host = WideHostRef::new(foreign, 2, 1, 0).unwrap();
    assert!(BridgeTransit::new(&ctx(), 2, t).is_err());
    let other_ctx = AddrCtx {
        season: [13; 32],
        program: [12; 32],
    };
    assert!(authenticate_pair(&other_ctx, &holding, 2, &external, &marker, &bridge).is_err());
    for arrival in [10, 11, 83, u32::MAX] {
        let mut t = bridge.transit();
        t.arrive_bell = arrival;
        assert!(BridgeTransit::new(&ctx(), 2, t).is_err());
    }
    let mut t = bridge.transit();
    t.troops_after = 1;
    assert!(BridgeTransit::new(&ctx(), 2, t).is_err());
    let mut t = bridge.transit();
    t.state = MarchState::Free;
    assert!(BridgeTransit::new(&ctx(), 2, t).is_err());
    let mut t = settled(&bridge).transit();
    t.troops_after = t.dep_mass + 1;
    assert!(BridgeTransit::new(&ctx(), 2, t).is_err());
    let mut t = bridge.transit();
    t.state = MarchState::Gathered;
    t.dest = Some(t.host.key());
    assert_eq!(BridgeTransit::new(&ctx(), 2, t), Err(BridgeError::Family));
}

#[test]
fn capture_clears_only_original_bond_and_projection_never_repays_it() {
    let (marker, bridge, holding, external) = fixture();
    let pending = authenticate_pair(&ctx(), &holding, 2, &external, &marker, &bridge).unwrap();
    assert!(matches!(
        pending.financial_input(3, 5),
        Err(BridgeError::State)
    ));
    let bridge = settled(&bridge);
    let pair = authenticate_pair(&ctx(), &holding, 2, &external, &marker, &bridge).unwrap();
    let before = pair.financial_input(3, 5).unwrap();
    assert_eq!(
        (before.transit.tip, before.fee, before.bond, before.total),
        (7, 3, 5, 15)
    );
    let plan = marker.capture_bond_plan(15, 5).unwrap();
    assert_eq!((plan.refund, plan.escrow_after), (5, 10));
    assert_eq!(plan.marker_after.tip(), 7);
    assert_eq!(plan.marker_after.flags(), T::FLAG_FEE_ESCROWED);
    assert_eq!(
        plan.marker_after.capture_bond_plan(10, 5).unwrap().refund,
        0
    );
    assert!(matches!(
        marker.capture_bond_plan(4, 5),
        Err(BridgeError::Escrow)
    ));
    let pair =
        authenticate_pair(&ctx(), &holding, 2, &external, &plan.marker_after, &bridge).unwrap();
    let after = pair.financial_input(3, 5).unwrap();
    assert_eq!(
        (after.transit.tip, after.fee, after.bond, after.total),
        (7, 3, 0, 10)
    );
    assert_eq!(bridge.transit().tip, 0);
    assert_eq!(bridge.transit().flags & 3, 0);
}

#[test]
fn pure_transitions_preserve_rent_identity_and_refuse_replay() {
    let (marker, bridge, holding, external) = fixture();
    let settled = settled(&bridge);
    assert!(settled
        .step(
            &ctx(),
            MarchEvent::SettleDeparture { destroyed: false },
            Some((80_000, 500, 2))
        )
        .is_err());
    assert!(BridgeMarker::new(&ctx(), &settled, 7, 3).is_err());
    let destination = ProvinceKey::new(
        bridge.transit().host.key().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    let gathered = settled
        .step(&ctx(), MarchEvent::Gather { dest: destination }, None)
        .unwrap();
    assert_eq!(gathered.transit().rent_to, bridge.transit().rent_to);
    assert_eq!(gathered.transit().host, bridge.transit().host);
    assert!(authenticate_pair(&ctx(), &holding, 2, &external, &marker, &gathered).is_ok());
    assert!(gathered
        .step(&ctx(), MarchEvent::Gather { dest: destination }, None)
        .is_err());
    assert!(
        gathered
            .step(&ctx(), MarchEvent::SettleTransit, None)
            .is_err(),
        "terminal operation closes envelope, never stores Free"
    );
    let dead = bridge
        .step(
            &ctx(),
            MarchEvent::SettleDeparture { destroyed: true },
            None,
        )
        .unwrap();
    assert_eq!(dead.transit().troops_after, 0);
    assert!(authenticate_pair(&ctx(), &holding, 2, &external, &marker, &dead).is_ok());
}

#[test]
fn financial_overflow_and_all_four_shared_positions() {
    let (marker, bridge, holding, _) = fixture();
    for slot in 0..4 {
        let initial = BridgeTransit::new(&ctx(), slot, bridge.transit()).unwrap();
        let external = transit_address(&ctx(), &holding, slot);
        let record = settled(&initial);
        let pair = authenticate_pair(&ctx(), &holding, slot, &external, &marker, &record).unwrap();
        assert!(matches!(
            pair.financial_input(u64::MAX, 5),
            Err(BridgeError::Overflow)
        ));
        let huge = BridgeMarker::new(&ctx(), &initial, u64::MAX, 3).unwrap();
        let pair = authenticate_pair(&ctx(), &holding, slot, &external, &huge, &record).unwrap();
        assert!(matches!(
            pair.financial_input(1, 0),
            Err(BridgeError::Overflow)
        ));
        assert!(authenticate_pair(
            &ctx(),
            &holding,
            (slot + 1) % 4,
            &external,
            &marker,
            &record
        )
        .is_err());
    }
}

#[test]
fn marker_decoder_checks_identity_origin_and_time_without_external_account() {
    let (marker, _, _, _) = fixture();
    let mut bytes = marker.to_bytes();
    bytes[T::HOST_ID..T::HOST_ID + 8].fill(255);
    assert!(BridgeMarker::from_bytes(&ctx(), &bytes).is_err());
    let mut bytes = marker.to_bytes();
    bytes[T::ORIGIN_P..T::ORIGIN_P + 2].copy_from_slice(&129i16.to_le_bytes());
    assert_eq!(
        BridgeMarker::from_bytes(&ctx(), &bytes),
        Err(BridgeError::Family)
    );
    let mut bytes = marker.to_bytes();
    bytes[T::ARRIVE_BELL..T::ARRIVE_BELL + 4].copy_from_slice(&11u32.to_le_bytes());
    assert!(BridgeMarker::from_bytes(&ctx(), &bytes).is_err());
    for (at, value) in [(T::UNIT, 8), (T::FACTION, 6), (T::ORIGIN_TILE, 61)] {
        let mut bytes = marker.to_bytes();
        bytes[at] = value;
        assert!(BridgeMarker::from_bytes(&ctx(), &bytes).is_err());
    }
}

#[test]
fn absent_financial_flags_never_invent_an_obligation() {
    let (_, bridge, holding, external) = fixture();
    let marker = BridgeMarker::new(&ctx(), &bridge, 0, 0).unwrap();
    assert_eq!(marker.capture_bond_plan(0, u64::MAX).unwrap().refund, 0);
    let record = settled(&bridge);
    let pair = authenticate_pair(&ctx(), &holding, 2, &external, &marker, &record).unwrap();
    let input = pair.financial_input(u64::MAX, u64::MAX).unwrap();
    assert_eq!(
        (input.transit.tip, input.fee, input.bond, input.total),
        (0, 0, 0, 0)
    );
}
