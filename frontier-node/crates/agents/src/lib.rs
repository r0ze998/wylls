//! `frontier-agents` (M1 contract §8.6, unit W3-E): what a Frontier bot is
//! and how it decides, with no IO.
//!
//! | module | what |
//! |---|---|
//! | [`campaign`] | MC §8.6: the faction campaign planner, a field-equal port of the simulator's (CQ2-F) |
//! | [`cqbehave`] | MC §8.6 behaviours (march, horn, retire, expand) and the local DeclareSiege / FileOutpost / RetireHost checks |
//! | [`cqfixture`] | a fixed MC herald world (Province v2, Citizens, Holdings) for the conquest tests |
//! | [`cqobs`] | MC §8.4 herald files (`PSFCT1`, `PSFOV2`, sieges) and the planner's world from the herald |
//! | [`cqpersona`] | the nineteen conquest personas of MC §8.6 and their expected outcomes |
//! | [`profile`] | `Arch`/`Profile` copied from `frontier-sim/src/model.rs` (equality test, I-36); the mix and roster |
//! | [`persona`] | the thirteen adversarial personas and their expected outcomes |
//! | [`rng`] | the simulator's SplitMix64 |
//! | [`keys`] | wallet, session and direct keys from the fleet seed |
//! | [`obs`] | herald files (§8.4, §9.2, §9.3) → an [`obs::Observation`] |
//! | [`path`] | march paths over observed provinces (Reveal check 6) |
//! | [`policy`] | [`policy::decide`]: observation → intents, deterministic in (seed, observation) |
//! | [`fixture`] | the fixed herald world the unit tests read |
//! | [`recorded`] | the recorded herald fixtures: load one, and the marches its wallets plan (W6-C) |
//!
//! The runner, transports, sealing and journal are `frontier-bots`.

pub mod campaign;
pub mod cqbehave;
pub mod cqfixture;
pub mod cqobs;
pub mod cqpersona;
pub mod fixture;
pub mod keys;
pub mod obs;
pub mod path;
pub mod persona;
pub mod policy;
pub mod profile;
pub mod recorded;
pub mod rng;

pub use persona::Persona;
pub use profile::{profile, AgentSpec, Arch, Mix, Profile, ARCHS};
