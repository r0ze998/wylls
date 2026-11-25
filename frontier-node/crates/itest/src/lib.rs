//! `itest`: the Frontier's in-process integration tests (M1 contract §3.5,
//! §11 W4-F, §12 Gate W4, I-57; **G14** of Gate W5, W5-C:
//! `tests/g14.rs`, 100 bots × 2 game days through the program with the
//! native kernel re-run every bell, verifier PASS, a tampered log FAIL).
//!
//! **`inproc_day`** (`tests/inproc_day.rs`): 100 bots, the keeper and the
//! herald fold over `ChainPort::InProcess` (LiteSVM + virtual time at 20×)
//! with the test-beacon program and the test key, one game day, then a
//! short keeper-only drain. The gate's pass conditions are read from the
//! chain afterwards ([`checks`]): zero stuck province-bells, every transit
//! settled or routed by rule, every bad seal destroyed at settlement with
//! the code the stock `tlock` opener gives.
//!
//! The pieces:
//!
//! | module | what |
//! |---|---|
//! | [`program`] | the test-beacon `.so` (`PSF_FRONTIER_SO`, else built with `scripts/build-frontier.sh --features test-beacon`) |
//! | [`world`] | the chain, the season announced and created by rule, the Clock-gated test-key drand |
//! | [`relay`] | the relay's public listener as an in-process stand-in on `127.0.0.1:0` (shape allowlist, quotas, drain guard by simulation, co-sign, `/f/reveal` → the keeper's API) |
//! | [`direct`] | the bots' direct port over the in-process chain (personas' own transactions) |
//! | [`standin`] | **stub mode only**: the resolution stand-in for the first run before W4-A/W4-C merge |
//! | [`day`] | the orchestrated run: one loop moves time; keeper tick per slot, herald ingest and due bots every few slots |
//! | [`checks`] | the chain's facts after the run and the named pass conditions |
//! | [`gate`] | the named conditions of a run, shared by `inproc_day` and G14 |
//! | [`native`] | G14's native kernel at every bell: each CLASH re-run, each SKIP replayed bell by bell (W5-C) |
//!
//! **Two modes.** The gate runs the strict mode (no stand-in; a stub of an
//! unmerged unit answering `NotImplemented` fails the run). `ITEST_STUBS=1`
//! runs the first run of the brief: the resolution stand-in lets resident
//! actions and marches happen before W4-A/W4-C land, and the conditions
//! that need the missing units are reported `PENDING`, never `PASS`.

#[cfg(feature = "localnet-expedition-play")]
pub mod expedition_play;
// ②+⑨+⑩ in one local world on the coexist lane artefact (TEST-ONLY, workstream 4 rev 8).
#[cfg(feature = "localnet-coexist-harness")]
pub mod coexist_play;
#[cfg(feature = "localnet-expedition-play")]
pub mod keeper_loop;
// TEST-ONLY player homes first on the compressed local clocks (runner-throughput-2, BREAK-143-1)
#[cfg(feature = "localnet-expedition-play")]
pub mod home_gate;
// TEST-ONLY runner throughput measurement (counters of landing waits, simulations, drand fetches; per-pass phases)
#[cfg(feature = "localnet-expedition-play")]
pub mod local_keeper;
#[cfg(feature = "localnet-expedition-play")]
pub mod origin_driver;
#[cfg(feature = "localnet-expedition-play")]
pub mod prof;
// the ordinary (legacy) march of a legacy village: SettleDeparture, Decrypt, Reveal, the destination's bells, SettleTransit
#[cfg(feature = "localnet-expedition-play")]
pub mod legacy_march;
// the keeper's holding and home on a natural world, from one landed PlaceHome (pure)
#[cfg(feature = "localnet-expedition-play")]
pub mod natural_home;
// the natural world: a new Season by its own instructions, the player's real Join and PlaceHome, then the keeper
#[cfg(feature = "localnet-expedition-play")]
pub mod natural_play;
// TEST-ONLY: the natural world's continuous preset and its private run dir (stop and resume), both opt-in
#[cfg(feature = "localnet-expedition-play")]
pub mod natural_persist;
// TEST-ONLY capture demo on a natural world: a synthetic clock and test participants, the program's own instructions
#[cfg(feature = "localnet-expedition-play")]
pub mod capture_demo;
pub mod checks;
#[cfg(feature = "localnet-conquest-play")]
pub mod conquest_crank;
#[cfg(all(test, feature = "localnet-conquest-play"))]
mod conquest_real;
#[cfg(feature = "localnet-conquest-play")]
pub mod conquest_world;
/// TEST-ONLY contest pair: a second player's wallet and village in the same memory-only world (two people; no automatic opponent).
#[cfg(feature = "localnet-expedition-play")]
pub mod contest_pair;
pub mod day;
#[cfg(feature = "localnet-expedition-play")]
pub mod destination_driver;
#[cfg(all(test, feature = "localnet-expedition-play"))]
mod destination_real;
pub mod direct;
pub mod gate;
/// TEST-ONLY land lane: the land preview's FoldLand / ClaimLandYield crank beside the keeper (feature `localnet-land-play`).
#[cfg(feature = "localnet-land-play")]
pub mod land_lane;
pub mod native;
// TEST-ONLY operator AI war world (with the capture demo): the keeper also serves the operator residents' villages, and
// the rest of the demo's new ring is opened by the program's own OpenProvince so every nation has keeps to contest
#[cfg(feature = "localnet-expedition-play")]
pub mod operator_villages;
pub mod program;
pub mod relay;
#[cfg(feature = "localnet-expedition-play")]
pub mod resident_bells;
pub mod standin;
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_destination;
// TEST-ONLY wide land on a natural world: the devnet wide preset, the map grown to the rim, wide rings 129+
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_land;
// TEST-ONLY local play rules (the centre free; the wide world's Hamlet anchor) and wide play (rim homes, wide claims' duty)
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_play;
// TEST-ONLY wide -> wide marches and wide keep capture (Q-W2, owner t385u): the crank of the wide bells and marches
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_depart;
// TEST-ONLY map growth where nations go (expansion-gameplay-1): wide land opened next to villages and won keeps
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_frontier;
// TEST-ONLY player territory (territory-impl, owner 2026-11-24 12:09): upkeep settles, decay and conquest transfers
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_territory;
// TEST-ONLY research (world goal ②, research-impl, owner 2026-11-25 08:56): settles and applies, once a bell
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_research;
pub mod world;
