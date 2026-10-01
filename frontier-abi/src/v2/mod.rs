//! **ABI v2** (MC "Contested Ground", `docs/frontier/conquest/
//! CONQUEST-CONTRACT.md` v1.1 §5–§7): a strict superset of the frozen M1
//! ABI, published **under new names beside v1** (R-16).
//!
//! | module | contract | content |
//! |---|---|---|
//! | [`layout`] | §5.2 | Province v2 (4,736 B), the site mirror, conquest record, keep and snapshot layouts, Holding / Citizen / JoinShard reserve fields, Season v2, MarchState; `AccountKind` v2 |
//! | [`tags`] | §5.4 | `Ix` v2 (57 instructions; `tags::Ix::ALL_V2`), classes, reserved tags, relay shapes |
//! | [`error`] | §5.3 | codes 62–78 (`CqError`) and the union `Code` |
//! | [`log`] | §6 | kinds 80–88, entity kind 8, the v2 decoder, chains, CONQUEST's payload |
//! | [`ix`] | §5.5, §5.6 | the new instructions' data, FileOutpost, CreateSeason v2 |
//! | [`presets`] | §3.12, §5.2.5 | `ConquestParams`, `SeasonParamsV2`, `MC_LOCAL_7D`, `MC_SEASON_28`, `MC_TEST`, `RULESET_HASH_V2` |
//! | [`budgets`] | §5.4, §13.1 | budget placeholders, the v2 `L(kind)` set |
//! | [`prologue`] | §5.5, §5.6 | v2 account lists, `check_present_v2`, the capture lock |
//! | [`entry`] | §3.1, §3.2 | the retire-style Leave and the lead host |
//! | [`addr`] | §5.2.6 | the MarchState seed `mc` |
//! | [`kernel`] | §7 | **temporary** bridge to the CQ1-A kernels (see its doc) |
//!
//! The shared models live beside v1's: [`crate::conquest_model`] (§5.7)
//! and the `_v2` functions of [`crate::clash_model`] (keep and Free City
//! garrisons, the `PSF-CLASH-INPUT-v2` digest, the skip tile-mask model).
//!
//! Every v1 name keeps its value: M1's `RULESET_HASH`, `Ix::ALL`, the
//! v1 vectors and every v1 function are unchanged (Gate CQ1 checks the
//! generated v1 outputs come out byte-identical).

pub mod addr;
pub mod budgets;
pub mod entry;
pub mod error;
pub mod ix;
pub mod kernel;
pub mod layout;
pub mod log;
pub mod presets;
pub mod prologue;
pub mod tags;

pub use error::{Code, CqError};
pub use tags::Ix;

/// ABI version carried in v2 chained headers and the v2 vector files.
pub const ABI_VERSION_V2: u16 = 2;
