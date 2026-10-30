//! Workstream 09: lending a workshop's processing capacity.
//!
//! Owner A takes workshop copies out of the facility Holding's own
//! conversion and lends them; user B, under A's grant, reserves copies for
//! a window, brings materials, and the lent copies convert them at the
//! workshop's real rate over real time; B claims the products. A signs
//! once (OpenPool, Lend, Grant) and may then be away; B's operations need
//! only B's key.
//!
//! What is real and what is not (`../README.ja.md`):
//! * real: `permutation_rules`' `Holding` (A's continuous production), the
//!   workshop's recipe numbers, the caravan walk the demo uses;
//! * the capacity accounts and operations: this crate (no on-chain
//!   instruction yet; patch 0002 specifies them);
//! * custody: [`custody::MockCustody`], a stand-in for ⑩.

pub mod custody;
pub mod error;
pub mod event;
pub mod facility;
pub mod ledger;
pub mod model;
pub mod plan;
pub mod policy;
pub mod recipe;

pub use error::CapError;
pub use ledger::{Op, Outcome, World};
pub mod testkit;
