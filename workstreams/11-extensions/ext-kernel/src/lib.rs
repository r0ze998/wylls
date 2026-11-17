//! Workstream 11 prototype of proposal B: an extension is a manifest of
//! declared state and closed effects that the core interprets.
//!
//! - [`manifest`]: canonical bytes, id, static check (contract §1–§2).
//! - [`exec`]: the interpreter, a pure function over one user's state and
//!   Holding; core resources move through `Holding::pay`/`credit` only.
//! - [`registry`], [`grant`]: the minimal registry and user permission
//!   (workstreams 06 and 02/09/10 own the real ones).
//! - [`host`]: the core side's checks and atomic commit.
//! - [`receipt`], [`verify`]: the record and the third party's replay.
//! - [`describe`]: what the user reads before granting.
//! - [`buffer`]: chunked publication, registered only after the hash check.
//!
//! `no_std` + `alloc`, like the rules crate it uses, so the same code can
//! link into the program (patches/0002); this workstream only builds it on
//! the host.

#![no_std]

extern crate alloc;

pub mod buffer;
pub mod describe;
pub mod error;
pub mod examples;
pub mod exec;
pub mod grant;
pub mod host;
pub mod manifest;
pub mod receipt;
pub mod registry;
pub mod verify;

pub use error::{ExtError, Layer};
