//! `fclient`: the Frontier off-chain spine (M1 contract §8.1).
//!
//! | module | what |
//! |---|---|
//! | [`abi`] | tags, classes, budgets, magics, sizes, errors, log kinds, layout offsets (re-exports `frontier-abi` from W2-F on) |
//! | [`addr`] | canonical with-seed and PDA addresses, citizen and keeper tags, host ids |
//! | [`ix`] | one builder per instruction, account order as §5 |
//! | [`decode`] | account decoders |
//! | [`log`] | the PS2 log parser, encoder and head chains |
//! | [`fees`], [`budgets`] | §10.1 formulas incl. `L(kind)`; per-kind CU and loaded-data limits |
//! | [`tx`] | compute budget, legacy messages, signing, shapes, priority |
//! | [`http`], [`rpc`] | loopback HTTP client, JSON-RPC client and `ChainPort` over it |
//! | [`ports`] | `ChainPort`, `DrandPort` and their types |
//! | [`beacon`] | quicknet info, blstrs verify, SP-V2 hints, seeds, the test-beacon key, drand backends |
//! | [`seal`] | the 37-B plaintext, tlock seals, the stock opener and seal codes |
//! | [`land`] | ticket scores and order, cohorts, expiry, the ring crowding rule, dormancy (W3-C) |
//! | [`play`] | seal opening, reveal order and slot index, path provinces, gather parts, settlement rank (W4-C) |
//! | [`clash_model`] | the program's ClashInput builder over account bytes (herald, verifier; integ-W4 review) |
//! | [`conquest`] | MC (ABI v2): typed conquest log records, the contested-province test, the March fold's readiness (CQ2-D) |
//! | [`clock`] | rule times and the `GameClock` |
//! | [`payers`] | reveal and delay pools, uniform draws, funders, payer care |
//! | [`vectors`] | `permutation-gateway/test/frontier-vectors.json` |
pub mod abi;
pub mod addr;
pub mod beacon;
pub mod budgets;
/// Bounded public blockhash reads; no signing or transaction admission.
pub mod blockhash_preflight;
pub mod clash_model;
pub mod clock;
pub mod conquest;
pub mod decode;
pub mod fees;
pub mod http;
pub mod ix;
pub mod land;
pub mod log;
pub mod payers;
pub mod play;
pub mod ports;
pub mod rpc;
/// Opt-in bounded HTTPS transport restricted to public read-only RPC methods.
pub mod readonly_https_rpc;
pub mod seal;
#[cfg(feature = "snapshot")]
pub mod snapshot;
pub mod tx;
/// Keyless legacy-message shape and external blockhash observation checks.
pub mod unsigned_message_preflight;
/// Explicit unsigned messages for the separate host-only execution revision.
#[cfg(feature = "expedition-dispatch-experimental")]
pub mod experimental_expedition_message;
#[cfg(feature = "wide-records-experimental")]
pub mod typed_log;
/// Real 264-byte wide march seals (fresh key, stock tlock); legacy `seal` untouched.
#[cfg(feature = "wide-records-experimental")]
pub mod wide_seal;
pub mod vectors;
/// Closed resident account/byte proposals, never an executable instruction.
#[cfg(feature = "wide-records-experimental")]
pub mod wide_resident_draft;
/// Closed account/byte proposal of the one player-signed conquest step
/// (wide DeclareSiege by an original host); never an executable instruction.
#[cfg(feature = "wide-records-experimental")]
pub mod wide_conquest_draft;

/// Closed original-host outbound account and byte proposals only.
#[cfg(feature = "wide-records-experimental")]
pub mod original_expedition_depart_draft;

/// Read-only original source/route/Clock context, never execution admission.
#[cfg(all(feature = "snapshot", feature = "wide-records-experimental"))]
pub mod original_outbound_snapshot;

/// Closed original resolved-member settlement account and byte proposals.
#[cfg(feature = "wide-records-experimental")]
pub mod original_expedition_settlement_draft;

pub use solana_address::Address;
pub use solana_hash::Hash;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;
pub use solana_transaction::Transaction;
