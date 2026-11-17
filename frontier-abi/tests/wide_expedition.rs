#![cfg(feature = "world-index-experimental")]
//! Public literal addresses and hashes only; no keys, signing or native crypto.
use frontier_abi::{
    addr::{self, AddrCtx},
    world_index::{
        expedition::{AccountFamily, AccountResolver},
        holding, land, LegacyError, ProvinceKey, WideCoord, WideHostRef, WorldId,
    },
};
use permutation_rules::frontier::geometry::{provinces_within, ProvinceCoord};

fn ctx() -> AddrCtx {
    AddrCtx {
        season: [11; 32],
        program: [12; 32],
    }
}

#[test]
fn every_legacy_province_selects_original_accounts() {
    let ctx = ctx();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    for index in 0..provinces_within(128) {
        let c = ProvinceCoord::from_index(index);
        let key = resolver.adapter().key_of(c);
        assert_eq!(resolver.family(key), Ok(AccountFamily::Legacy));
        assert_eq!(resolver.province_address(key), Ok(ctx.province(c.p, c.q)));
        let id = addr::host_id(c.p, c.q, 11, 255, u32::MAX).unwrap();
        let host = resolver.legacy_host_ref(id).unwrap();
        assert_eq!(resolver.legacy_host_id(&host), Ok(id));
        assert_eq!(
            resolver.holding_address(&host),
            Ok(ctx.holding(c.p, c.q, 11))
        );
    }
}

#[test]
fn ring_boundary_and_large_coordinates_never_choose_shadow_accounts() {
    let ctx = ctx();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    for (p, q) in [(128, 0), (0, -128), (-128, 128), (-64, -64)] {
        let key = ProvinceKey::new(
            resolver.adapter().world(),
            WideCoord::checked(p, q).unwrap(),
        );
        let host = WideHostRef::new(key, 2, 7, 19).unwrap();
        assert_eq!(resolver.family(key), Ok(AccountFamily::Legacy));
        assert_ne!(
            resolver.province_address(key).unwrap(),
            land::province_address(&ctx, key.coord())
        );
        assert_ne!(
            resolver.holding_address(&host).unwrap(),
            holding::holding_address(&ctx, key.coord(), 2)
        );
    }
    for (p, q) in [
        (129, 0),
        (0, -129),
        (-129, 129),
        (-65, -64),
        (1i64 << 54, 0),
    ] {
        let key = ProvinceKey::new(
            resolver.adapter().world(),
            WideCoord::checked(p, q).unwrap(),
        );
        let host = WideHostRef::new(key, 2, 7, 19).unwrap();
        assert_eq!(resolver.family(key), Ok(AccountFamily::Wide));
        assert_eq!(
            resolver.province_address(key),
            Ok(land::province_address(&ctx, key.coord()))
        );
        assert_eq!(
            resolver.holding_address(&host),
            Ok(holding::holding_address(&ctx, key.coord(), 2))
        );
        assert!(resolver.legacy_host_id(&host).is_err());
    }
}

#[test]
fn original_issued_identity_is_not_reissued_or_rebased_at_destination() {
    let ctx = ctx();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    for site in 0..12 {
        for (gen, seq) in [(0, 0), (1, 1), (255, u32::MAX)] {
            let id = addr::host_id(128, 0, site, gen, seq).unwrap();
            let host = resolver.legacy_host_ref(id).unwrap();
            assert_eq!((host.site(), host.gen(), host.seq()), (site, gen, seq));
            assert_eq!(resolver.legacy_host_id(&host), Ok(id));
            assert_eq!(
                resolver.holding_address(&host),
                ctx.holding_of_host(id)
                    .ok_or(LegacyError::InvalidHostId(id))
            );
            assert_eq!(
                resolver.holding_address(&host),
                resolver.holding_address(&host.holding_ref())
            );
            let destination =
                ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
            assert_eq!(resolver.family(destination), Ok(AccountFamily::Wide));
            assert_eq!(resolver.family(host.key()), Ok(AccountFamily::Legacy));
        }
    }
}

#[test]
fn invalid_ids_and_wrong_world_are_refused_before_address_selection() {
    let resolver = AccountResolver::for_season(&ctx()).unwrap();
    for id in [u64::MAX, 12u64 << 40, (49_537u64) << 44] {
        assert_eq!(
            resolver.legacy_host_ref(id),
            Err(LegacyError::InvalidHostId(id))
        );
    }
    for p in [128, 129, 1i64 << 54] {
        let key = ProvinceKey::new(
            WorldId::new([99; 32]).unwrap(),
            WideCoord::checked(p, 0).unwrap(),
        );
        let host = WideHostRef::new(key, 0, 1, 1).unwrap();
        assert!(matches!(
            resolver.family(key),
            Err(LegacyError::WorldMismatch { .. })
        ));
        assert!(matches!(
            resolver.province_address(key),
            Err(LegacyError::WorldMismatch { .. })
        ));
        assert!(matches!(
            resolver.holding_address(&host),
            Err(LegacyError::WorldMismatch { .. })
        ));
        assert!(matches!(
            resolver.legacy_host_id(&host),
            Err(LegacyError::WorldMismatch { .. })
        ));
    }
    let other = AccountResolver::for_season(&AddrCtx {
        season: [13; 32],
        program: [12; 32],
    })
    .unwrap();
    let host = resolver
        .legacy_host_ref(addr::host_id(0, 0, 0, 1, 1).unwrap())
        .unwrap();
    assert!(matches!(
        other.holding_address(&host),
        Err(LegacyError::WorldMismatch { .. })
    ));
}
