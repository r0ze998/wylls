//! Tickets (redesign stage 2, decisions L1–L9;
//! `docs/frontier/stage2/S2-2A-CONTRACT.md`): an **issue** is one kind of
//! ticket from one source (a vault for shares and receipts, a workshop for
//! use rights), and a **lot** is one holder's units of it.
//!
//! - A ticket is valid while its source is in the generation it was issued
//!   in: a vault's seizure or a holding's capture raises the generation and
//!   voids every ticket of it (stage 2 rule "a seized vault's tickets are
//!   void").
//! - Shares (2b, L2) count a vault's goods in value units by [`SHARE_VALUE`];
//!   a withdrawal takes the same fraction of every store (a basket).
//! - Issuing costs [`ISSUE_FEE`], paid from a holding and burned (L8).
//!
//! The program, the verifier and the herald share this module; its tables
//! are bound into `RULESET_HASH_V4`.

use crate::fixed::Milli;
use crate::frontier::holding::RESOURCES;

/// Version of this module's rules (bound into `RULESET_HASH_V4`).
pub const TICKET_VERSION: u16 = 1;

/// Issue kinds.
pub const KIND_SHARE: u8 = 1;
pub const KIND_RECEIPT: u8 = 2;
pub const KIND_USE: u8 = 3;
/// A one-time receipt an exchange leaves (2e, L6).
pub const KIND_DELIVERY: u8 = 4;
pub const KINDS: [u8; 4] = [KIND_SHARE, KIND_RECEIPT, KIND_USE, KIND_DELIVERY];

/// Source kinds (the `Place` kinds of S1).
pub const SRC_HOLDING: u8 = 1;
pub const SRC_VAULT: u8 = 2;

/// Issue and lot states.
pub const STATE_LIVE: u8 = 1;
pub const STATE_CLOSED: u8 = 2;

/// `until_day` of a ticket with no end.
pub const NO_END: u32 = u32::MAX;

/// Live issues a citizen may have [phase 6].
pub const MAX_OPEN_ISSUES: u8 = 8;
/// Units of one issue [phase 6].
pub const MAX_SUPPLY: u64 = 1_000_000;
/// The fee to issue tickets (whole units: gold), paid from a holding and
/// burned [phase 6].
pub const ISSUE_FEE: [i64; RESOURCES] = [0, 0, 0, 0, 0, 20, 0, 0];
/// A share's value of one unit of each resource (L2) [phase 6]: food, wood,
/// stone, ore, arms, gold, science, influence (the last two are not goods:
/// 0).
pub const SHARE_VALUE: [u64; RESOURCES] = [1, 1, 1, 2, 4, 3, 0, 0];

/// [`ISSUE_FEE`] in milli-units.
pub fn issue_fee() -> [Milli; RESOURCES] {
    ISSUE_FEE.map(|x| x * 1_000)
}

/// Why issue terms are refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TermsError {
    Kind,
    Amount,
    Resource,
    PerUnit,
    UntilDay,
}

/// The terms of a receipt or use issue (`IssueTickets`); shares and
/// deliveries are made by their own instructions. `cap` is the vault's
/// capacity per resource (milli), for a receipt; `today` the current day.
pub fn check_terms(
    kind: u8,
    resource: u8,
    amount: u64,
    per_unit: u64,
    until_day: u32,
    cap: Milli,
    today: u32,
) -> Result<(), TermsError> {
    if kind != KIND_RECEIPT && kind != KIND_USE {
        return Err(TermsError::Kind);
    }
    if amount == 0 || amount > MAX_SUPPLY {
        return Err(TermsError::Amount);
    }
    if kind == KIND_RECEIPT {
        if resource as usize >= RESOURCES || SHARE_VALUE[resource as usize] == 0 {
            return Err(TermsError::Resource);
        }
        if per_unit == 0 || per_unit > cap.max(0) as u64 {
            return Err(TermsError::PerUnit);
        }
    } else if resource != 0 || per_unit == 0 || per_unit > 24 {
        // A use ticket names no resource; its runs a day are at most a
        // workshop's hours.
        return if resource != 0 {
            Err(TermsError::Resource)
        } else {
            Err(TermsError::PerUnit)
        };
    }
    if until_day != NO_END && until_day < today {
        return Err(TermsError::UntilDay);
    }
    Ok(())
}

/// Whether a ticket issued at `ticket_gen` is still valid for a source now
/// in `source_gen` with `source_live`.
pub const fn valid(ticket_gen: u8, source_gen: u8, source_live: bool) -> bool {
    source_live && ticket_gen == source_gen
}

/// A vault's value in share value units: Σ stores (milli) / 1000 ×
/// [`SHARE_VALUE`] (2b).
pub fn value_of(stores: &[Milli; RESOURCES]) -> u128 {
    stores
        .iter()
        .zip(SHARE_VALUE.iter())
        .map(|(&s, &v)| (s.max(0) as u128 / 1_000) * v as u128)
        .sum()
}

/// Appends this module's tables to the S2 ruleset hash input.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    out.extend_from_slice(&TICKET_VERSION.to_le_bytes());
    out.extend_from_slice(&KINDS);
    out.push(MAX_OPEN_ISSUES);
    out.extend_from_slice(&MAX_SUPPLY.to_le_bytes());
    for f in ISSUE_FEE {
        out.extend_from_slice(&f.to_le_bytes());
    }
    for v in SHARE_VALUE {
        out.extend_from_slice(&v.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_terms() {
        let cap = 5_000_000;
        assert_eq!(
            check_terms(KIND_RECEIPT, 3, 10, 20_000, NO_END, cap, 5),
            Ok(())
        );
        assert_eq!(check_terms(KIND_USE, 0, 3, 2, 9, cap, 5), Ok(()));
        assert_eq!(
            check_terms(KIND_SHARE, 0, 3, 0, NO_END, cap, 5),
            Err(TermsError::Kind)
        );
        assert_eq!(
            check_terms(KIND_RECEIPT, 3, 0, 1, NO_END, cap, 5),
            Err(TermsError::Amount)
        );
        assert_eq!(
            check_terms(KIND_RECEIPT, 3, MAX_SUPPLY + 1, 1, NO_END, cap, 5),
            Err(TermsError::Amount)
        );
        assert_eq!(
            check_terms(KIND_RECEIPT, 6, 1, 1, NO_END, cap, 5),
            Err(TermsError::Resource),
            "science is no good"
        );
        assert_eq!(
            check_terms(KIND_RECEIPT, 8, 1, 1, NO_END, cap, 5),
            Err(TermsError::Resource)
        );
        assert_eq!(
            check_terms(KIND_RECEIPT, 3, 1, cap as u64 + 1, NO_END, cap, 5),
            Err(TermsError::PerUnit)
        );
        assert_eq!(
            check_terms(KIND_USE, 0, 1, 25, NO_END, cap, 5),
            Err(TermsError::PerUnit)
        );
        assert_eq!(
            check_terms(KIND_USE, 2, 1, 1, NO_END, cap, 5),
            Err(TermsError::Resource)
        );
        assert_eq!(
            check_terms(KIND_USE, 0, 1, 1, 4, cap, 5),
            Err(TermsError::UntilDay)
        );
    }

    #[test]
    fn validity_follows_the_generation() {
        assert!(valid(3, 3, true));
        assert!(!valid(3, 4, true), "seized");
        assert!(!valid(3, 3, false), "closed");
    }

    #[test]
    fn a_vaults_value() {
        let mut s = [0i64; RESOURCES];
        s[1] = 100_000; // 100 wood
        s[3] = 50_500; // 50.5 ore: whole units count
        s[6] = 9_000_000; // science is no good
        assert_eq!(value_of(&s), 100 + 50 * 2);
    }
}
