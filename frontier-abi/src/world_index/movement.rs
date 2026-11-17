//! Quotes the existing movement cost schedule on exact wide tiles.
//!
//! This is an experimental pure prerequisite, not a game instruction. It
//! neither creates land nor moves assets. Both sources must describe the same
//! immutable captured snapshot; their reports are not proof of finality or
//! ownership. Unknown terrain is refused, not replaced with plains. A caller
//! must separately authenticate the world, accounts, sender and snapshot.
use super::key::WorldId;
use super::tiles::{
    verify_route, ProvinceSource, RouteBounds, RouteError, TileAddress, VerifiedRoute, WideTile,
};
use permutation_rules::{frontier::travel::hex_secs, map::Terrain, units::UnitType};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReportedTile {
    pub address: TileAddress,
    pub terrain: Terrain,
    pub road: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteQuote {
    pub route: VerifiedRoute,
    pub seconds: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteError {
    Route(RouteError),
    UnknownTile(TileAddress),
    SourceTileMismatch {
        expected: TileAddress,
        got: TileAddress,
    },
    Impassable {
        step: usize,
    },
    Overflow,
}

/// Uses the unchanged `travel::hex_secs` schedule for each entered tile.
/// No global coordinate is narrowed to the legacy `Hex` type. The result is
/// only a quote: arrival timing, permissions, collisions and settlement are
/// deliberately not authorized by this function.
pub fn quote_reported_route<S, T>(
    world: WorldId,
    start: &WideTile,
    steps: &[WideTile],
    bounds: RouteBounds,
    provinces: &S,
    terrain: &T,
    unit: UnitType,
) -> Result<RouteQuote, QuoteError>
where
    S: ProvinceSource,
    T: Fn(&TileAddress) -> Option<ReportedTile>,
{
    let route = verify_route(world, start, steps, bounds, provinces).map_err(QuoteError::Route)?;
    let mut seconds = 0u32;
    for (step, tile) in steps.iter().enumerate() {
        let expected = tile.address();
        let report = terrain(&expected).ok_or(QuoteError::UnknownTile(expected))?;
        if report.address != expected {
            return Err(QuoteError::SourceTileMismatch {
                expected,
                got: report.address,
            });
        }
        let cost =
            hex_secs(report.terrain, report.road, unit).ok_or(QuoteError::Impassable { step })?;
        seconds = seconds.checked_add(cost).ok_or(QuoteError::Overflow)?;
    }
    Ok(RouteQuote { route, seconds })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::{IndexEntry, Lookup, ProvinceKey, ReportedState, WideCoord};
    use alloc::vec::Vec;
    use permutation_rules::{
        frontier::{
            geometry::tile_index,
            travel::{path_cost, Step},
        },
        hex::Hex,
    };

    fn world(n: u8) -> WorldId {
        WorldId::new([n; 32]).unwrap()
    }
    fn open(key: &ProvinceKey) -> Result<Lookup, super::super::IndexError> {
        Ok(Lookup::Known(IndexEntry {
            key: *key,
            revision: 1,
            state: ReportedState::Open,
            observed_at: 1,
        }))
    }
    fn report(a: &TileAddress, terrain: Terrain, road: bool) -> Option<ReportedTile> {
        Some(ReportedTile {
            address: *a,
            terrain,
            road,
        })
    }

    #[test]
    fn quotes_equal_legacy_for_every_unit_terrain_and_road() {
        let w = world(1);
        let start = WideTile::checked(w, 0, 0).unwrap();
        let tiles: Vec<_> = (1..=16)
            .map(|q| WideTile::checked(w, q, 0).unwrap())
            .collect();
        for unit in [
            UnitType::Spearman,
            UnitType::Archer,
            UnitType::Horseman,
            UnitType::Pikeman,
            UnitType::Crossbowman,
            UnitType::Knight,
            UnitType::Scout,
            UnitType::Settler,
        ] {
            for terrain in [
                Terrain::Grassland,
                Terrain::Plains,
                Terrain::Forest,
                Terrain::Hills,
            ] {
                for road in [false, true] {
                    let legacy: Vec<_> = tiles
                        .iter()
                        .map(|t| Step {
                            hex: t.legacy_hex().unwrap(),
                            terrain,
                            road,
                        })
                        .collect();
                    let expected = path_cost(Hex::ORIGIN, &legacy, unit).unwrap();
                    let got = quote_reported_route(
                        w,
                        &start,
                        &tiles,
                        RouteBounds::LEGACY,
                        &open,
                        &|a| report(a, terrain, road),
                        unit,
                    )
                    .unwrap();
                    assert_eq!(got.seconds, expected.secs);
                    assert_eq!(got.route.steps, expected.hexes as usize);
                    assert_eq!(got.route.provinces.len(), expected.provinces.len());
                }
            }
        }
    }

    #[test]
    fn unknown_wrong_and_impassable_tiles_are_not_priced_as_open_ground() {
        let w = world(1);
        let start = WideTile::checked(w, 0, 0).unwrap();
        let tiles = [WideTile::checked(w, 1, 0).unwrap()];
        let quote = |source: &dyn Fn(&TileAddress) -> Option<ReportedTile>| {
            quote_reported_route(
                w,
                &start,
                &tiles,
                RouteBounds::LEGACY,
                &open,
                &source,
                UnitType::Scout,
            )
        };
        assert_eq!(
            quote(&|_| None),
            Err(QuoteError::UnknownTile(tiles[0].address()))
        );
        for wrong in [
            start.address(),
            WideTile::checked(world(2), 1, 0).unwrap().address(),
        ] {
            assert_eq!(
                quote(&|_| report(&wrong, Terrain::Plains, false)),
                Err(QuoteError::SourceTileMismatch {
                    expected: tiles[0].address(),
                    got: wrong
                })
            );
        }
        for terrain in [Terrain::Water, Terrain::Mountain] {
            assert_eq!(
                quote(&|a| report(a, terrain, true)),
                Err(QuoteError::Impassable { step: 0 })
            );
        }
        let unknown = |_: &ProvinceKey| Ok(Lookup::Unknown);
        assert!(matches!(
            quote_reported_route(
                w,
                &start,
                &tiles,
                RouteBounds::LEGACY,
                &unknown,
                &|a| report(a, Terrain::Plains, false),
                UnitType::Scout
            ),
            Err(QuoteError::Route(RouteError::UnknownProvince { .. }))
        ));
    }

    #[test]
    fn same_schedule_crosses_ring_129_and_keeps_far_coordinates_exact() {
        let w = world(1);
        for p in [128, 1i64 << 54] {
            let origin = ProvinceKey::new(w, WideCoord::checked(p, 0).unwrap());
            let start = WideTile::of(
                TileAddress::new(origin, tile_index(Hex::new(4, 0)).unwrap()).unwrap(),
            );
            let next = WideTile::checked(w, start.q() + 1, start.r()).unwrap();
            assert_ne!(next.province(), start.province());
            assert_eq!(next.province().coord().p(), p + 1);
            let got = quote_reported_route(
                w,
                &start,
                &[next],
                RouteBounds::LEGACY,
                &open,
                &|a| report(a, Terrain::Hills, true),
                UnitType::Horseman,
            )
            .unwrap();
            assert_eq!(
                got.seconds,
                hex_secs(Terrain::Hills, true, UnitType::Horseman).unwrap()
            );
            assert_eq!(got.route.end, next.address());
        }
    }
}
