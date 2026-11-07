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
//! | [`placement::mixed_home_nation`] | candidate mixed-nation rule (owner decision: outer lands mix nations, not six wedges): Concord neutral, ring-1 seats keep their wedges, every ring ≥ 2 a balanced cyclic six-nation order with a seed-derived per-ring offset; the legacy `home_nation` offset bit for bit for rings ≤ 65,535, a versioned domain past it; `u128` ring arithmetic; not a Season parameter, not wired into any legacy rule |
//! | [`land::WideRingSeed`], [`land::WideProvince`] | **draft write-path records** (2026-11-07): a world-scoped `u64`-ring seed whose round is the kernel's `ring_seed_round` and whose seed is only ever a verified quicknet round's (no genesis path); and a wide province that is the **whole Province v2 layout** plus a world/coordinate/provenance trailer, openable only under decided keep-holder, Free City, camp and region rules ([`land::WideRules`], undecided today: `NotReady`); provisional magics and seed tags, reachable only by a program built with `wide-world-experimental` |
//! | [`holding`] | ownership of a wide site under the **one inventory** rule: a wide holding takes one of the Citizen's three deployed slots (2 or 3) through an impossible marker ref every deployed writer reads as taken, and its record is the whole Holding v2 layout plus a trailer that refuses any host, transit or explore debit under the unallocated host identity |
//! | [`march`] | the wide march record over `WideHostRef` with the legacy lifecycle's state table; the decided host identity version (the full reference as identity, a top-bit roster alias for lookup only, domain-separated wide formulas for slot, tie and clash seed, a with-seed transit record address), which no wide holding carries yet, so every departure is still refused |
//! | [`rules`] | the explicit, versioned **experimental rules configuration** of a wide world (one record per Season, written by the Season's authority) and the **candidate** keep-holder, Free City, camp and region functions it selects; an unset byte refuses, so without the record an opening stays `NotReady`; nothing in it is an approved rule |
//! | [`ticket`] | the **wide outpost ticket**: a world/coordinate-bound record (one per Citizen) that carries a wide claim through the deployed outpost lifecycle, the Citizen marker that reserves the one deployed ticket and the slot while it is pending (every deployed ticket path refuses), the isolated holding-rent escrow the record holds and retains between tickets under the deployed FileOutpost / SettleTicket / CloseCitizen escrow rules (`TicketStatus`, `WideTicket::{settle, refile}`), and the full-width versioned ticket score |
//! | [`wide_ix`] | the draft wire envelope: nine instructions in the unallocated band `0xD6..=0xDE`, their account lists, and the `0x4000` program-version bit of an experimental wide build |
//!
//! **What it is not.** The index records what a caller *reports*. It does
//! not authorise opening land, decide who may open it, prove that an
//! OpenProvince is final, grant ownership, hold balances, or issue any
//! asset. The tile geometry names where land *would* be on the lattice;
//! it generates no terrain, opens nothing, and a verified route moves
//! nothing. It is not an account layout, and it does not replace
//! `ProvinceCoord::index`, `host_id`, `travel::path_cost`, the control
//! file or the prize bitmap, all of which keep their current meaning for
//! the current ABI. The `land`, `holding` and `march` records are the
//! versioned identity and transition models of the wide write path. The
//! experimental program writes through them the ring seed's request and
//! verified consumption, a wide province (only under an explicit
//! [`rules`] configuration, from the wedge fund, with the deployed
//! terrain, keep, camp, Free City and fund bookkeeping), a wide outpost
//! ticket under the deployed FileOutpost prerequisites and its settlement
//! under the deployed SettleTicket lottery (the beacon draw, fresh,
//! displace, taken, expired; a provisional wide holding and its lazy
//! finality); the march entry point refuses at the host-identity gate. An
//! unbounded live game needs,
//! beyond this module, the decisions listed in
//! `docs/frontier/map-growth/WIDE-WORLD-INDEX.md` and
//! `docs/frontier/map-growth/WIDE-LAND-WRITER.md`.

pub mod coord;
pub mod holding;
pub mod index;
pub mod key;
pub mod land;
pub mod legacy;
pub mod march;
pub mod movement;
pub mod placement;
pub mod rules;
pub mod ticket;
pub mod tiles;
pub mod wide_ix;

pub use coord::{CoordError, RingPosition, WideCoord, SORT_KEY_LEN, WIDE_BOUND};
pub use holding::{HoldingError, SlotBinding, WideHolding, HOST_IDENTITY_UNALLOCATED};
pub use index::{
    Cursor, CursorFault, IndexEntry, IndexError, Lookup, OpenedProvinceIndex, Page, ReportedState,
    SnapshotFault, Window, FIRST_REVISION, MAX_PAGE,
};
pub use key::{KeyError, ProvinceKey, WideHostRef, WorldId, HOST_REF_LEN, PROVINCE_KEY_LEN};
pub use land::{
    Decision, LandError, PreviousRing, SeedStatus, WideProvince, WideRingSeed, WideRules,
    FIRST_WIDE_RING, WIDE_LAND_FAMILY_VERSION, WIDE_LAYOUT_VERSION,
};
pub use legacy::{legacy_of, wide_of, LegacyAdapter, LegacyError};
pub use march::{
    claim_alias, resolve_wide_clash, transit_address, wide_clash_seed, wide_host_alias,
    wide_plain_commit, wide_slot_key, wide_tie_key, AliasError, MarchError, MarchEvent, MarchState,
    WideClashError, WideClashInput, WideClashOutcome, WideFighter, WideGarrison, WideTransit,
    HOST_IDENTITY_FULL_REF_V1,
};
pub use placement::{
    mixed_home_nation, ring_offset, ring_offset_domain, RingOffsetDomain, LEGACY_OFFSET_MAX_RING,
    MIXED_PLACEMENT_DOMAIN_WIDE, MIXED_PLACEMENT_VERSION,
};
pub use rules::{
    CampRule, FreeCityRule, KeepHolderRule, RegionRule, RuleBytes, RulesError, WideRulesConfig,
    WIDE_RULES_CONFIG_VERSION,
};
pub use ticket::{wide_ticket_score, CitizenTicket, TicketError, TicketStatus, WideTicket};
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
