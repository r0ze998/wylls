//! Frontier kernels that no ruleset hash binds yet (design/redesign 30).
//!
//! Every module under `frontier` has a `KERNEL_VERSIONS` entry and is part
//! of the M1 or conquest ruleset hash (`tests/frontier_shared.rs` checks
//! this). The kernels here are new rules that no running season uses: the
//! simulator and tests call them, the program does not. When a ruleset
//! version adopts one, it moves into `frontier` with its version entry and
//! its tables in that version's hash input.

pub mod arms;
