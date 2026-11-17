//! Workstream 10: custody (`workstreams/10-custody/02-contract.ja.md`).
//!
//! Goods stay their owner's while another citizen keeps them (a **lot** in
//! the keeper's vault), carries them (a **custody caravan**) or uses a
//! bounded amount of them (a **use order**). Five roles stay apart:
//!
//! | Role | Where it is written | Who it is |
//! |---|---|---|
//! | owner | `Lot.OWNER_CITIZEN`, `Caravan.CUSTODY_OWNER_TAG` | the depositor |
//! | custodian | the vault's `OWNER_CITIZEN` (read at every step) | the vault's owner |
//! | carrier | the caravan's `OWNER_CITIZEN` / `FACTION` | the signer of a ship order |
//! | user | `Order.GRANTEE` of a use order | the signer of a use order |
//! | location | the lot's vault and generation, or an inbound caravan | — |
//!
//! Everything in [`lot`] and [`layout`] is a pure function of its inputs,
//! `no_std` + `alloc`, in the style of `permutation_rules::frontier`: the
//! program, the verifier and the keeper would call the same code
//! (patches/0001 moves it to `permutation-rules/src/frontier/custody.rs`).
//! [`model`] (feature `model`, std) runs these kernels against a model of
//! the program's accounts and the S1 instructions they meet (SendCaravan,
//! SettleCaravan, raids, SeizeVault, CloseVault); it is **not** the
//! program.
//!
//! Every number marked [phase 6] is a placeholder.

#![cfg_attr(not(feature = "model"), no_std)]

extern crate alloc;

pub mod layout;
pub mod lot;

// The model indexes parallel per-resource arrays (stores, cargo, credited).
#[cfg(feature = "model")]
#[allow(clippy::needless_range_loop)]
pub mod model;

pub use lot::*;
