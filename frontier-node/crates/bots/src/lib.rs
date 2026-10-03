//! `frontier-bots` (M1 contract §8.6, unit W3-E): runs `frontier-agents`
//! bots against a season — observations from the herald (the people's read
//! path), every write through the relay (`/f/join`, `/f/relay`,
//! `/f/reveal`), marches sealed with the Rust `tlock` crate to the herald's
//! drand key (the test key in gates), the marchbook journalled before a
//! Depart is signed, owner reveals in the arrival bell, and the thirteen
//! adversarial personas (their own funded key only where the relay never
//! sponsors: `--rpc`).
//!
//! | module | what |
//! |---|---|
//! | [`ports`] | herald, relay and direct ports; HTTP, directory and RPC implementations |
//! | [`seal`] | honest, garbage and bad-plaintext seals on a shared pool |
//! | [`journal`] | the marchbook (JSON lines, fsync, restore) |
//! | [`txb`] | the relay's sponsored shapes and direct transactions |
//! | [`conquest`] | MC §8.6 `--conquest`: the fleet's planner epoch, orders, the horn, outposts, retire, the conquest personas |
//! | [`cqtx`] | the v2 instructions a bot signs (DeclareSiege, FileOutpost, RetireHost) (adapters over `fclient::ix::v2`) |
//! | [`bot`] | one bot: observe → decide → act; the shared environment |
//! | [`fleet`] | 1,000 bots per process: schedules, `step_all`, `run` |
//! | [`report`] | outcomes and persona verdicts for the stack report |
//!
//! The in-process system test (100 bots, one game day) is W4-F's
//! `itest::inproc_day`; it drives [`fleet::Fleet::step_all`] over its own
//! ports.

pub mod bot;
pub mod conquest;
pub mod control;
pub mod cqtx;
pub mod fleet;
pub mod journal;
pub mod ports;
pub mod report;
pub mod seal;
pub mod txb;
