//! **Experimental, opt-in** (`--features world-index-experimental`): wide
//! province coordinates, world-scoped keys, versioned host references and
//! a sparse opened-province index for a world that is not a disk.
//!
//! This is a foundation for the "one unbounded lattice" and "several
//! worlds" readings of `docs/frontier/map-growth/UNBOUNDED-IDENTIFIERS.md`.
//! It is pure, `no_std` + `alloc`. Its only consumers are **read-only and
//! themselves opt-in**: the herald's `wide` module and the web client's
//! `map/wide.mjs` (herald feature `wide-world-experimental`,
//! `docs/frontier/map-growth/WIDE-WORLD-INDEX.md` §4.4) show captured
//! records through the legacy adapter. The program, the keeper and the
//! verifier do not reach it, and no consumer of [`tiles`] exists. Nothing
//! here is reachable from a default build, nothing is wired into a
//! deployed account layout or seed string, and no ruleset hash input
//! mentions it. Turning the feature on changes no vector, hash, address
//! or budget.
//!
//! What it gives, and the invariants its tests pin:
//!
//! | piece | invariant |
//! |---|---|
//! | [`coord::WideCoord`] | `i64` (P, Q) within ±2⁶², all arithmetic in `i128`; ring ≤ 2⁶³; a step or a turn that would leave the bound is refused, never wrapped |
//! | sort key (17 bytes) | lossless; byte order = ring order; equal to the legacy dense order for all 49,537 provinces of ring ≤ 128; non-canonical bytes refused |
//! | [`key::WorldId`] | immutable 32-byte namespace; the zero id is reserved; a legacy season's namespace is a sha256 of its public Season PDA and program |
//! | [`key::ProvinceKey`], [`key::WideHostRef`] | versioned byte layouts (50 and 56 bytes), lossless, never a `u64` |
//! | [`legacy::LegacyAdapter`] | `ProvinceCoord` ↔ wide exact; dense index and `u64` host id only within ring 128 and only in the adapter's world; refused past it (no aliasing into the 20-bit field) |
//! | [`index::OpenedProvinceIndex`] | one `BTreeMap` per world, no radius-sized allocation; insert once at revision 1, update at exactly the next revision; replay, conflict, stale and gap each a named error; cross-world keys, entries and cursors refused; pages ≤ 256 entries served by a bounded `range` walk; a cursor dies at the first mutation; canonical snapshot and strict restore |
//! | [`tiles::WideTile`], [`tiles::TileAddress`] | the legacy radius-4, 61-tile province lattice (centre `(9P + 4Q, −4P + 5Q)`, legacy `tile_offset` / `tile_index` for the local index) over wide provinces, every tile coordinate an `i128` computed in `i128`; tile ↔ (province key, local index) round-trips for every tile of every province of ring ≤ 128 identically to the legacy `locate`, and at ring 129, past 2⁵³ and at the far corners; a tile whose province lies past the bound is refused, never wrapped |
//! | [`tiles::verify_route`] | adjacent steps only, caller-stated bounds capped at the legacy 32 steps and 4 provinces, every province stood on reported open by a caller-supplied source; unknown, closed and other-world land refuse; no cost, time, stamina or dispatch |
//!
//! **What it is not.** The index records what a caller *reports*. It does
//! not authorise opening land, decide who may open it, prove that an
//! OpenProvince is final, grant ownership, hold balances, or issue any
//! asset. The tile geometry names where land *would* be on the lattice;
//! it generates no terrain, opens nothing, and a verified route moves
//! nothing. It is not an account layout, and it does not replace
//! `ProvinceCoord::index`, `host_id`, `travel::path_cost`, the control
//! file or the prize bitmap, all of which keep their current meaning for
//! the current ABI. An unbounded live game needs, beyond this module, the
//! ABI, state, keeper, view and economy decisions listed in
//! `docs/frontier/map-growth/WIDE-WORLD-INDEX.md`.

pub mod coord;
pub mod index;
pub mod key;
pub mod legacy;
pub mod movement;
pub mod tiles;

pub use coord::{CoordError, RingPosition, WideCoord, SORT_KEY_LEN, WIDE_BOUND};
pub use index::{
    Cursor, CursorFault, IndexEntry, IndexError, Lookup, OpenedProvinceIndex, Page, ReportedState,
    SnapshotFault, Window, FIRST_REVISION, MAX_PAGE,
};
pub use key::{KeyError, ProvinceKey, WideHostRef, WorldId, HOST_REF_LEN, PROVINCE_KEY_LEN};
pub use legacy::{legacy_of, wide_of, LegacyAdapter, LegacyError};
pub use tiles::{
    verify_route, ProvinceSource, RouteBounds, RouteError, TileAddress, TileError, VerifiedRoute,
    WideTile, TILE_COORD_BOUND,
};

#[cfg(test)]
mod tests {
    use super::*;
    use permutation_rules::frontier::geometry::{ProvinceCoord, R_MAX_HARD};

    /// The pieces compose: a legacy host id becomes a wide reference, its
    /// province a key the index can hold, and the whole walk back is exact.
    #[test]
    fn legacy_host_to_wide_index_and_back() {
        let ctx = crate::addr::AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        let adapter = LegacyAdapter::for_season(&ctx).unwrap();
        let mut idx = OpenedProvinceIndex::new(adapter.world());
        let id = crate::addr::host_id(7, -3, 4, 2, 9).unwrap();
        let r = adapter.host_ref(id).unwrap();
        idx.insert(IndexEntry {
            key: r.key(),
            revision: FIRST_REVISION,
            state: ReportedState::Open,
            observed_at: 100,
        })
        .unwrap();
        let Lookup::Known(e) = idx.lookup(&r.key()).unwrap() else {
            panic!("inserted");
        };
        assert_eq!(adapter.coord_of(&e.key), Ok(ProvinceCoord::new(7, -3)));
        assert_eq!(adapter.host_id(&r), Ok(id));
        assert_eq!(
            adapter.dense_index_of(&e.key),
            Ok(ProvinceCoord::new(7, -3).index())
        );
        // a province past the legacy disk sits in the same index, with no
        // legacy identity at all
        let far = ProvinceKey::new(
            adapter.world(),
            WideCoord::checked(R_MAX_HARD as i64 + 1, 0).unwrap(),
        );
        idx.insert(IndexEntry {
            key: far,
            revision: FIRST_REVISION,
            state: ReportedState::Open,
            observed_at: 101,
        })
        .unwrap();
        assert_eq!(
            adapter.dense_index_of(&far),
            Err(LegacyError::BeyondLegacyDisk { ring: 129 })
        );
        let page = idx.first_page(Window::all(), MAX_PAGE).unwrap();
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.entries[0].key, r.key());
        assert_eq!(page.entries[1].key, far);
        assert!(page.next.is_none());
    }

    /// Enabling the feature leaves every pinned production constant alone.
    #[test]
    fn production_limits_are_untouched() {
        use permutation_rules::frontier::geometry::provinces_within;
        assert_eq!(R_MAX_HARD, 128);
        assert_eq!(provinces_within(R_MAX_HARD as u32), 49_537);
        assert!(provinces_within(R_MAX_HARD as u32) < 1 << 20);
        assert_eq!(crate::ABI_VERSION, 1);
        assert_eq!(crate::addr::host_id(129, 0, 0, 0, 0), None);
        assert_eq!(permutation_rules::frontier::geometry::GEOMETRY_VERSION, 1);
        assert_eq!(permutation_rules::frontier::addr::ADDR_VERSION, 1);
    }
}
