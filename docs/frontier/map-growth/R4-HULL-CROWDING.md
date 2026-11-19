# ⑭ R4 — crowding θ over the settled hull: design and blocker (not implemented)

## What the code does (permutation-frontier/src/proc/map.rs)
- `ring_occupancy_met(occupied[6], open[6], θ)`: OpenRing / ExtendFrontier open the next WHOLE ring when
  SOME of the six geometric wedges has `occupied × 10000 ≥ θ × open` on the folded Frontier counters
  (`WEDGE_OPEN`, `WEDGE_OCCUPIED`, six u32 each; θ early/late by `now − genesis_ts`).
- The counters are per geometric wedge (`fund_wedge` / `holding_wedge`), bumped by PlaceHome /
  SettleTicket / ReleaseDormant and OpenProvince's `open_sites`; FoldOccupancy folds them.
- Land opens as rings (RingSeed per ring, `rings_opened`, genesis rings ≤ 4).

## What R4 asks
"θ over the settled hull, not per wedge/ring; open land as chunks around settlements (CDDA-style)".

## Why it is not tractable without R3
1. A settled hull is a geometric set (convex hull or k-neighbourhood of the settled provinces). The
   program has no such set: no account holds a hull, a nearest-settlement index or per-chunk occupancy.
   Building it is R3's prerequisite ("a hull or nearest-settlement index on chain (a new account or a
   herald-proof)"), and R3 is deferred (large ABI change, not recommended before devnet).
   *(Update 2026-11-19: R3 is implemented without a stored hull — PlaceHome takes an optional
   witness Province within `spawn_reach` (conquest byte 82, `presets::spawn_allows`). A
   per-transaction witness gives θ nothing to read, so this blocker stands.)*
2. "Open land as chunks around settlements" replaces RingSeed / OpenRing / `rings_opened`, which the
   dense host index, ExtendFrontier, the herald's ring-indexed paths and the page's ring seeds all use.
   That is a layout and ABI change of the same size as R3 (and touches R5's index).
3. With land still opened ring by ring, the only θ that is "not per wedge" and needs no new state is a
   GLOBAL θ (Σ occupied ≥ θ × Σ open over the six counters). That is not the hull, and it changes how
   fast the map grows (any-wedge opens earlier than the sum). Choosing it is a new rule question:
   **blocked on r0ze** (and better decided together with R3).

## Note on placement 2
Under placement 2 the nations are interleaved on every ring, so the geometric wedge counters already
mix nations: "some wedge crowded" is a geometric sextant measure, not a per-nation one. This is
consistent with ⑧ (i) and needs no change for R1/⑧ (c).

## Recommendation
Skip R4 in this PR. If r0ze wants an interim change before R3, the candidate is
`ring_occupancy_met` = Σ-over-wedges (one function, a `geometry`/map version bump, the sim's
mapmove thresholds re-measured) — decision needed first.
