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
#[cfg(feature = "localnet-expedition-play")]
pub mod local_keeper;
#[cfg(feature = "localnet-expedition-play")]
pub mod keeper_loop;
#[cfg(feature = "localnet-expedition-play")]
pub mod origin_driver;
// the ordinary (legacy) march of a legacy village: SettleDeparture, Decrypt, Reveal, the destination's bells, SettleTransit
#[cfg(feature = "localnet-expedition-play")]
pub mod legacy_march;
// the keeper's holding and home on a natural world, from one landed PlaceHome (pure)
#[cfg(feature = "localnet-expedition-play")]
pub mod natural_home;
// the natural world: a new Season by its own instructions, the player's real Join and PlaceHome, then the keeper
#[cfg(feature = "localnet-expedition-play")]
pub mod natural_play;
// TEST-ONLY capture demo on a natural world: a synthetic clock and test participants, the program's own instructions
#[cfg(feature = "localnet-expedition-play")]
pub mod capture_demo;
/// TEST-ONLY contest pair: a second player's wallet and village in the same memory-only world (two people; no automatic opponent).
#[cfg(feature = "localnet-expedition-play")]
pub mod contest_pair;
#[cfg(feature = "localnet-expedition-play")]
pub mod wide_destination;
#[cfg(feature = "localnet-expedition-play")]
pub mod destination_driver;
#[cfg(all(test, feature = "localnet-expedition-play"))]
mod destination_real;
#[cfg(feature = "localnet-expedition-play")]
pub mod resident_bells;
#[cfg(feature = "localnet-conquest-play")]
pub mod conquest_crank;
#[cfg(feature = "localnet-conquest-play")]
pub mod conquest_world;
#[cfg(all(test, feature = "localnet-conquest-play"))]
mod conquest_real;
pub mod checks;
pub mod day;
pub mod direct;
pub mod gate;
pub mod native;
pub mod program;
pub mod relay;
pub mod standin;
pub mod world;
