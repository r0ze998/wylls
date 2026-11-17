#![cfg(feature = "world-index-experimental")]
//! Key-free constructor tests: literal public identities and terrain bytes only.
//! No account fixtures, address derivation, signing, subprocesses, or native crypto.

use frontier_abi::bytes::{rd_arr, rd_i16, rd_i64, rd_u32, wr_i64};
use frontier_abi::layout::player::accrual as A;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::world_index::holding::{
    wide_holding as W, CapturedFreeCity, HoldingError, WideHolding, HOST_IDENTITY_UNALLOCATED,
};
use frontier_abi::world_index::{WideCoord, WorldId};
use permutation_rules::frontier::holding::{Holding, Resource, Tier, DORMANT_AFTER};

fn input() -> CapturedFreeCity {
    CapturedFreeCity {
        world: WorldId::new([7; 32]).unwrap(),
        season_id: 19,
        coord: WideCoord::checked((1i64 << 54) + 1, -129).unwrap(),
        site: 11,
        gen: 1,
        slot: 2,
        owner_citizen: [8; 32],
        tile: 1,
        tier: 0,
        captured_bell: 598,
        current_bell: Some(900),
        now: 80_000,
        rent_payer: [9; 32],
    }
}

fn citizen(expelled: i64) -> [u8; C::SIZE] {
    let mut d = [0u8; C::SIZE];
    d[C::FACTION] = 3;
    // Legacy funding can coexist and must never become the wide rent payer.
    d[C::TICKET_FUNDER..C::TICKET_FUNDER + 32].fill(0x55);
    assert!(wr_i64(&mut d, C::EXPELLED_SINCE, expelled));
    d
}

#[test]
fn captures_preserve_identity_and_exact_legacy_initial_economy() {
    for (tier_byte, tier) in [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold]
        .into_iter()
        .enumerate()
    {
        for slot in [2, 3] {
            for gen in [1, 254] {
                for expelled in [0, 123, -1] {
                    // Both plain terrain and ore-rich terrain, using only public bytes.
                    for (terrain, resource) in [([0; 61], [0; 61]), ([2; 61], [1; 61])] {
                        let x = CapturedFreeCity {
                            tier: tier_byte as u8,
                            slot,
                            gen,
                            ..input()
                        };
                        let c = citizen(expelled);
                        let before = c;
                        let d =
                            WideHolding::captured_free_city(x, &c, &terrain, &resource).unwrap();
                        assert_eq!(c, before, "constructor never mutates inventory or escrow");
                        let id = WideHolding::read(&d).unwrap();
                        assert_eq!(id.world, x.world);
                        assert_eq!(id.season_id, x.season_id);
                        assert_eq!(id.coord, x.coord);
                        assert_eq!((id.site, id.gen, id.slot), (x.site, gen, slot));
                        assert_eq!(id.owner_citizen, x.owner_citizen);
                        assert_eq!(id.host_identity, HOST_IDENTITY_UNALLOCATED);
                        assert_eq!(id.open_transits, 0);
                        assert_eq!(rd_i16(&d, H::P), Some(0));
                        assert_eq!(rd_i16(&d, H::Q), Some(0));
                        assert_eq!(d[H::STATE], H::STATE_FINAL);
                        assert_eq!(d[H::TILE], x.tile);
                        assert_eq!(d[H::FACTION], c[C::FACTION]);
                        assert_eq!(
                            d[H::FLAGS],
                            if expelled != 0 { H::FLAG_EXPELLED } else { 0 }
                        );
                        assert_eq!(rd_arr::<32>(&d, H::RENT_PAYER), Some(x.rent_payer));
                        assert_eq!(d[H::PREV_GEN], gen - 1);
                        assert_eq!(d[H::CAPTURE_FLAGS], H::CAPTURE_FLAG_CAPTURED);
                        assert_eq!(rd_u32(&d, H::CAPTURED_BELL), Some(x.captured_bell));
                        let day = frontier_abi::addr::day_of(x.current_bell.unwrap());
                        let ore = permutation_rules::frontier::arms::terrain_ore_per_hour_bytes(
                            &terrain, &resource, x.tile,
                        )
                        .unwrap();
                        // Exact pure-kernel sequence in legacy SettleCapture.
                        let mut legacy = Holding::found(x.now, day, slot);
                        legacy.tier = tier;
                        for s in &mut legacy.stores {
                            s.cap = tier.storage_cap();
                        }
                        legacy.production =
                            permutation_rules::frontier::arms::base_production(tier, ore);
                        legacy.set_upkeep(x.now, Resource::Food, 0).unwrap();
                        assert_eq!(rd_i64(&d, H::TERRAIN_ORE), Some(ore));
                        assert_eq!(d[H::TIER], tier_byte as u8);
                        assert_eq!(d[H::ORDER], slot);
                        assert_eq!(rd_u32(&d, H::FOUNDED_DAY), Some(day));
                        for offset in [H::FOUNDED_TS, H::LAST_OWNER_ACTION, H::FINAL_TS] {
                            assert_eq!(rd_i64(&d, offset), Some(x.now));
                        }
                        for (i, s) in legacy.stores.iter().enumerate() {
                            for (offset, value) in [
                                (A::VALUE, s.value),
                                (A::RATE, s.rate),
                                (A::CAP, s.cap),
                                (A::T0, s.t0),
                                (A::FRAC, s.frac),
                            ] {
                                assert_eq!(rd_i64(&d, H::store(i) + offset), Some(value));
                            }
                            assert_eq!(
                                rd_i64(&d, H::PRODUCTION + 8 * i),
                                Some(legacy.production[i])
                            );
                            assert_eq!(rd_i64(&d, H::UPKEEP + 8 * i), Some(0));
                        }
                        assert_eq!(rd_i64(&d, H::WALLS_COMMITTED_BEFORE), Some(i64::MIN));
                        for range in [
                            H::TICKET_SCORE..H::FACTION,
                            H::TICKET_BELL..H::FOUNDED_TS,
                            H::HOST_SEQ..H::LAST_OWNER_ACTION,
                            H::SHIELD_UNTIL..H::STORES,
                            H::QUEUE..H::WALLS_COMMITTED_BEFORE,
                            H::FOOD_SHORTFALL..H::RENT_PAYER,
                            H::POOL_OWED..H::PREV_GEN,
                            H::RSV_1258..H::CAPTURED_BELL,
                            H::PREV_HOME..H::TERRAIN_ORE,
                        ] {
                            assert!(d[range].iter().all(|b| *b == 0));
                        }
                        assert_eq!(d.len(), W::SIZE);
                    }
                }
            }
        }
    }
}

#[test]
fn current_bell_is_distinct_from_capture_bell_and_none_uses_day_zero() {
    let c = citizen(0);
    for bell in [None, Some(0), Some(u32::MAX)] {
        let x = CapturedFreeCity {
            current_bell: bell,
            ..input()
        };
        let d = WideHolding::captured_free_city(x, &c, &[0; 61], &[0; 61]).unwrap();
        assert_eq!(
            rd_u32(&d, H::FOUNDED_DAY),
            Some(frontier_abi::addr::day_of(bell.unwrap_or(0)))
        );
        assert_eq!(rd_u32(&d, H::CAPTURED_BELL), Some(598));
    }
}

#[test]
fn malformed_inputs_are_checked_without_mutating_sources() {
    let c = citizen(1);
    let make = |x| WideHolding::captured_free_city(x, &c, &[0; 61], &[0; 61]);
    for slot in [0, 1, 4, 255] {
        assert_eq!(
            make(CapturedFreeCity { slot, ..input() }),
            Err(if slot == 1 {
                HoldingError::FirstHomeIsLegacy
            } else {
                HoldingError::BadSlot(slot)
            })
        );
    }
    for gen in [0, 255] {
        assert_eq!(
            make(CapturedFreeCity { gen, ..input() }),
            Err(HoldingError::SiteOrGen { site: 11, gen })
        );
    }
    for site in [12, 255] {
        assert_eq!(
            make(CapturedFreeCity { site, ..input() }),
            Err(HoldingError::SiteOrGen { site, gen: 1 })
        );
    }
    for tier in [4, 255] {
        assert_eq!(
            make(CapturedFreeCity { tier, ..input() }),
            Err(HoldingError::CaptureTier(tier))
        );
    }
    for tile in [61, 255] {
        assert_eq!(
            make(CapturedFreeCity { tile, ..input() }),
            Err(HoldingError::CaptureTile(tile))
        );
    }
    assert_eq!(
        make(CapturedFreeCity {
            coord: WideCoord::checked(128, 0).unwrap(),
            ..input()
        }),
        Err(HoldingError::NotWide { ring: 128 })
    );
    for len in [0, C::SIZE - 1, C::SIZE + 1] {
        assert_eq!(
            WideHolding::captured_free_city(input(), &vec![0; len], &[0; 61], &[0; 61]),
            Err(HoldingError::Citizen)
        );
    }
    for faction in [6, 255] {
        let mut bad = c;
        bad[C::FACTION] = faction;
        assert_eq!(
            WideHolding::captured_free_city(input(), &bad, &[0; 61], &[0; 61]),
            Err(HoldingError::CaptureFaction(faction))
        );
    }
    assert_eq!(
        make(CapturedFreeCity {
            now: i64::MAX,
            ..input()
        }),
        Err(HoldingError::CaptureTime)
    );
    assert_eq!(c, citizen(1));
}

#[test]
fn timestamp_representability_bound_is_checked_not_an_invented_season_rule() {
    for now in [i64::MIN, -1, 0, i64::MAX - DORMANT_AFTER] {
        let d = WideHolding::captured_free_city(
            CapturedFreeCity { now, ..input() },
            &citizen(0),
            &[0; 61],
            &[0; 61],
        )
        .unwrap();
        assert_eq!(rd_i64(&d, H::FINAL_TS), Some(now));
    }
    assert_eq!(
        WideHolding::captured_free_city(
            CapturedFreeCity {
                now: i64::MAX - DORMANT_AFTER + 1,
                ..input()
            },
            &citizen(0),
            &[0; 61],
            &[0; 61]
        ),
        Err(HoldingError::CaptureTime)
    );
}
