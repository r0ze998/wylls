//! `frontier-er`: **candidate, not adopted.** The ephemeral-rollup (ER)
//! delegation lifecycle of one Wylls S1 target, modelled and reconciled.
//! Decision O8 (`docs/frontier/DECISIONS.md`: "Season 1 on Solana base
//! only; no … ER lane") still stands; nothing here changes the program, the
//! keeper, the herald or the verifier. The design and its limits are in
//! `docs/frontier/er-candidate/`.
//!
//! | module | what |
//! |---|---|
//! | [`sha256`] | SHA-256 for the chain-head rule, no dependencies |
//! | [`board`] | the candidate target: a value-free chained account and its compare-and-set write |
//! | [`sim`] | a deterministic model of base layer, delegation program, ER and committor, with faults |
//! | [`guard`] | the reconciler: base / ER / hold / stop from what each side reports |
//! | [`plan`] | the keeper's next step in a continuing world: commit, end a session (budget, rotation, drain), delegate again |
//! | [`outcome`] | whether a write landed, from state; when a "not found" status proves absence |

pub mod board;
pub mod guard;
pub mod outcome;
pub mod plan;
pub mod sha256;
pub mod sim;
