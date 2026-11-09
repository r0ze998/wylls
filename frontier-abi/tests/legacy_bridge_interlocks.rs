#![cfg(feature = "world-index-experimental")]
//! Closed guard fixtures: literal public identities only; no signing or keys.
use frontier_abi::{
    addr::{self, AddrCtx},
    layout::player::{holding as H, transit as T},
    prologue::{
        holding_transit_occupancy, host_in_transit, host_in_transit_with_bridge, transit_occupancy,
        TransitOccupancy,
    },
    world_index::{
        expedition::AccountResolver,
        expedition_bridge::{BridgeMarker, BridgeTransit},
        march::WideTransit,
        TileAddress, HOST_IDENTITY_FULL_REF_V1,
    },
};

fn fixture() -> (AddrCtx, [u8; 32], u64, Vec<u8>) {
    let ctx = AddrCtx {
        season: [11; 32],
        program: [12; 32],
    };
    let id = addr::host_id(128, 0, 2, 1, 0).unwrap();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver.legacy_host_ref(id).unwrap();
    let troop = WideTransit::depart(
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
    let bridge = BridgeTransit::new(&ctx, 2, troop).unwrap();
    let marker = BridgeMarker::new(
        &ctx,
        &bridge,
        7,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let mut hd = vec![0; H::SIZE];
    hd[H::transit(2)..H::transit(2) + T::SIZE].copy_from_slice(&marker.to_bytes());
    (ctx, resolver.holding_address(&host).unwrap(), id, hd)
}

#[test]
fn valid_legacy_states_keep_their_host_lock_and_admission() {
    let (ctx, key, id, mut hd) = fixture();
    for state in 0..=3 {
        hd[H::transit(2) + T::STATE] = state;
        let expected = state != 0;
        assert_eq!(host_in_transit(&hd, id), expected);
        assert_eq!(
            host_in_transit_with_bridge(&ctx, &key, &hd, id),
            Ok(expected)
        );
        assert_eq!(
            host_in_transit_with_bridge(&ctx, &key, &hd, id + 1),
            Ok(false)
        );
        assert_eq!(T::in_transit(state), expected);
        assert_eq!(
            transit_occupancy(&ctx, &key, &hd, 2).unwrap(),
            if expected {
                TransitOccupancy::Legacy
            } else {
                TransitOccupancy::Free
            }
        );
    }
}

#[test]
fn valid_bridge_locks_only_original_host_but_never_enters_legacy_admission() {
    let (ctx, key, id, hd) = fixture();
    assert!(matches!(
        transit_occupancy(&ctx, &key, &hd, 2),
        Ok(TransitOccupancy::Bridge(_))
    ));
    assert_eq!(host_in_transit_with_bridge(&ctx, &key, &hd, id), Ok(true));
    assert_eq!(
        host_in_transit_with_bridge(&ctx, &key, &hd, id + 1),
        Ok(false)
    );
    assert!(!host_in_transit(&hd, id));
    assert!(!T::in_transit(hd[H::transit(2) + T::STATE]));
    // Gather consumes Legacy only; its Bridge arm skips before result reads.
    assert_ne!(
        transit_occupancy(&ctx, &key, &hd, 2).unwrap(),
        TransitOccupancy::Legacy
    );
}

#[test]
fn malformed_unknown_wrong_holding_and_truncated_slots_fail_closed() {
    let (ctx, key, id, hd) = fixture();
    for offset in [T::RSV_93, 94, 95, T::TROOPS_AFTER, T::DEST_P, T::FLAGS] {
        let mut malformed = hd.clone();
        malformed[H::transit(2) + offset] ^= 0x80;
        assert!(transit_occupancy(&ctx, &key, &malformed, 2).is_err());
        assert!(host_in_transit_with_bridge(&ctx, &key, &malformed, id + 1).is_err());
    }
    for state in 5..=u8::MAX {
        let mut malformed = hd.clone();
        malformed[H::transit(2) + T::STATE] = state;
        assert!(transit_occupancy(&ctx, &key, &malformed, 2).is_err());
        assert!(!T::in_transit(state));
    }
    assert!(transit_occupancy(&ctx, &ctx.holding(127, 0, 2), &hd, 2).is_err());
    assert!(transit_occupancy(&ctx, &key, &hd, H::TRANSIT_N).is_err());
    assert!(host_in_transit_with_bridge(&ctx, &key, &hd[..H::transit(3)], id).is_err());
}

#[test]
fn malformed_last_slot_rejects_preflight_despite_matching_first_legacy_host() {
    let (ctx, key, id, mut hd) = fixture();
    let marker = hd[H::transit(2)..H::transit(2) + T::SIZE].to_vec();
    hd[H::transit(2)..H::transit(2) + T::SIZE].fill(0);
    hd[H::transit(0)..H::transit(0) + T::SIZE].copy_from_slice(&marker);
    hd[H::transit(0) + T::STATE] = T::STATE_SETTLED;
    hd[H::transit(3)..H::transit(3) + T::SIZE].copy_from_slice(&marker);
    assert!(host_in_transit(&hd, id));
    assert!(holding_transit_occupancy(&ctx, &key, &hd).is_ok());
    for state in [4, 5, 255] {
        hd[H::transit(3) + T::STATE] = state;
        hd[H::transit(3) + T::RSV_93] = 255;
        assert_eq!(
            transit_occupancy(&ctx, &key, &hd, 0),
            Ok(TransitOccupancy::Legacy)
        );
        assert!(holding_transit_occupancy(&ctx, &key, &hd).is_err());
        assert!(host_in_transit_with_bridge(&ctx, &key, &hd, id).is_err());
    }
}

#[test]
fn capture_recognizes_bridge_and_clears_only_current_bond_once_without_pair() {
    let (ctx, key, _, mut hd) = fixture();
    let TransitOccupancy::Bridge(marker) = transit_occupancy(&ctx, &key, &hd, 2).unwrap() else {
        panic!("valid bridge must be occupied during capture");
    };
    let first = marker.capture_bond_plan(30, 11).unwrap();
    assert_eq!(first.refund, 11);
    assert_eq!(first.escrow_after, 19);
    // The existing capture loop applies this same single flag clear and debit,
    // then pays/diverts to its authenticated victim. No external account input.
    let o = H::transit(2);
    hd[o + T::FLAGS] &= !T::FLAG_BOND_ESCROWED;
    assert_eq!(&hd[o..o + T::SIZE], &first.marker_after.to_bytes());
    let TransitOccupancy::Bridge(current) = transit_occupancy(&ctx, &key, &hd, 2).unwrap() else {
        panic!("capture must retain the bridge reservation");
    };
    assert_eq!(current.tip(), 7);
    assert_eq!(current.flags(), T::FLAG_FEE_ESCROWED);
    let replay = current.capture_bond_plan(first.escrow_after, 11).unwrap();
    assert_eq!(replay.refund, 0);
    assert_eq!(replay.escrow_after, first.escrow_after);
}
