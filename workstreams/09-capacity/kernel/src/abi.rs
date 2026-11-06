//! Workstream 09's numbers in the shared ABI, as workstream 4 allocated
//! them (provisional, `workstreams/04-execution/contracts/
//! ABI-ALLOCATION-20261106.ja.md` rev 3, branch `claude/gallant-ride-cunptv`
//! 8e96f24d). Behind the feature `abi-04-provisional` until 4 fixes them:
//! no program uses these numbers yet.
//!
//! | space | 4's band for 09 | here |
//! |---|---|---|
//! | instruction tag | 0xF0–0xFD (14) | the 14 instructions of patch 0002, in its order |
//! | game program error | 110–149 (≤ 40) | 110–139: `109 + CapError::code()` (codes 1–30) |
//! | AccountKind | 25 CapacityPool, 26 CapacityJob | the same; seeds `cp`, `cj` (4's); magic proposed |
//! | log kind | 120–129 (≤ 10) | **not assigned**: 09 has [`EVENT_KINDS`] = 20 kinds of record; 4 decides (§ below) |
//!
//! `Op::ClaimSplit` (patch 0003) has no tag of its own in this table: it is
//! proposed as `ClaimJob` with the split's arguments (the destinations of
//! the output, of each input's whole units and of the rest), so the 14
//! tags stay 14. A proposal; 4 may give it a tag instead.
//!
//! Log kinds: 20 kinds of record do not fit 10. Either 4 gives 09 twenty
//! kinds, or 09's records share kinds with a sub-kind byte. 09 does not
//! choose; [`event_index`] numbers them 0–19 for either.

use crate::error::CapError;
use crate::event::Event;
use crate::ledger::Op;

pub const TAG_OPEN_CAPACITY_POOL: u8 = 0xF0;
pub const TAG_LEND_CAPACITY: u8 = 0xF1;
pub const TAG_RECLAIM_CAPACITY: u8 = 0xF2;
pub const TAG_GRANT_CAPACITY: u8 = 0xF3;
pub const TAG_REVOKE_CAPACITY: u8 = 0xF4;
pub const TAG_RESERVE_CAPACITY: u8 = 0xF5;
pub const TAG_DEPOSIT_TO_JOB: u8 = 0xF6;
pub const TAG_SETTLE_JOB: u8 = 0xF7;
pub const TAG_CANCEL_JOB: u8 = 0xF8;
pub const TAG_CLAIM_JOB: u8 = 0xF9;
pub const TAG_RECORD_FACILITY_LOSS: u8 = 0xFA;
pub const TAG_RETIRE_JOB: u8 = 0xFB;
pub const TAG_RETIRE_GRANT: u8 = 0xFC;
pub const TAG_RETIRE_POOL: u8 = 0xFD;

/// 4's band for 09's instructions.
pub const TAGS: core::ops::RangeInclusive<u8> = 0xF0..=0xFD;

/// The instruction of an operation.
pub const fn tag(op: &Op) -> u8 {
    match op {
        Op::OpenPool { .. } => TAG_OPEN_CAPACITY_POOL,
        Op::Lend { .. } => TAG_LEND_CAPACITY,
        Op::Reclaim { .. } => TAG_RECLAIM_CAPACITY,
        Op::Grant { .. } => TAG_GRANT_CAPACITY,
        Op::Revoke { .. } => TAG_REVOKE_CAPACITY,
        Op::Reserve { .. } => TAG_RESERVE_CAPACITY,
        Op::Deposit { .. } => TAG_DEPOSIT_TO_JOB,
        Op::Settle { .. } => TAG_SETTLE_JOB,
        Op::Cancel { .. } => TAG_CANCEL_JOB,
        // Proposal: one instruction, the split's arguments optional.
        Op::Claim { .. } | Op::ClaimSplit { .. } => TAG_CLAIM_JOB,
        Op::FacilityLost { .. } => TAG_RECORD_FACILITY_LOSS,
        Op::Retire { .. } => TAG_RETIRE_JOB,
        Op::RetireGrant { .. } => TAG_RETIRE_GRANT,
        Op::RetirePool { .. } => TAG_RETIRE_POOL,
    }
}

/// 4's band for 09's program errors, and what 09 uses of it.
pub const ERRORS: core::ops::RangeInclusive<u32> = 110..=149;
pub const ERROR_BASE: u32 = 109;

/// The game program's error for a refusal of 09's kernel.
pub const fn program_error(e: CapError) -> u32 {
    ERROR_BASE + e.code() as u32
}

pub const ACCOUNT_KIND_CAPACITY_POOL: u8 = 25;
pub const ACCOUNT_KIND_CAPACITY_JOB: u8 = 26;
pub const SEED_CAPACITY_POOL: &[u8; 2] = b"cp";
pub const SEED_CAPACITY_JOB: &[u8; 2] = b"cj";
/// Proposed (4 lists the magic as open); distinct from every magic 4's
/// inventory found.
pub const MAGIC_CAPACITY_POOL: &[u8; 8] = b"PSF1CPOL";
pub const MAGIC_CAPACITY_JOB: &[u8; 8] = b"PSF1CJOB";

/// 4's band for 09's log kinds (≤ 10) and the kinds of record 09 has.
pub const LOG_KINDS: core::ops::RangeInclusive<u8> = 120..=129;
pub const EVENT_KINDS: usize = 20;

/// 09's records numbered 0–19 (not log kinds: see the module's note).
pub const fn event_index(e: &Event) -> u8 {
    match e {
        Event::PoolOpened { .. } => 0,
        Event::Lent { .. } => 1,
        Event::Reclaimed { .. } => 2,
        Event::Granted { .. } => 3,
        Event::Revoked { .. } => 4,
        Event::Reserved { .. } => 5,
        Event::Deposited { .. } => 6,
        Event::Started { .. } => 7,
        Event::Settled { .. } => 8,
        Event::Completed { .. } => 9,
        Event::Cancelled { .. } => 10,
        Event::Lost { .. } => 11,
        Event::Claimed { .. } => 12,
        Event::Forfeited { .. } => 13,
        Event::FacilityLost { .. } => 14,
        Event::Retired { .. } => 15,
        Event::Refunded { .. } => 16,
        Event::Receipt { .. } => 17,
        Event::GrantRetired { .. } => 18,
        Event::PoolRetired { .. } => 19,
    }
}
