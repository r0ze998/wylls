//! Workstream ④: a durable executor for multi-turn runs — inputs arrive,
//! a permitted facility is used, the result is sent by caravan, its arrival
//! is checked — that keeps resources and rights intact through stops,
//! duplicates and failures. See `README.ja.md`.
//!
//! - [`model`]: the Run, its states and the transition table.
//! - [`ports`]: the adapters to ② (rights) and ③ (canonical reads, sends).
//! - [`store`]: SQLite persistence, leases and compare-and-swap writes.
//! - [`executor`]: the state machine's steps.
//! - [`sim`]: **MOCK** canonical world with fault injection.
//! - [`policy`]: what may run without a person.
//! - [`acts`]: agent acts (workstreams 03, 05) registered under a run id, with one receipt.
//! - [`view`]: the machine-readable view of one run, read in one snapshot.

pub mod acts;
pub mod executor;
pub mod gateway;
pub mod model;
pub mod policy;
pub mod ports;
pub mod sim;
pub mod store;
pub mod view;
