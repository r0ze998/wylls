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

/// Version of this module's rules (bound into `RULESET_HASH_V4`): 2 adds
/// the share rules of 2b ([`minted`], [`basket`]), 3 the receipts' period of
/// 2c ([`Period`], [`grant`]).
pub const TICKET_VERSION: u16 = 3;

/// A receipt grant's ratio of one (parts per million, 2c).
pub const RATIO_ONE: u32 = 1_000_000;

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

/// Units a deposit mints into a share issue (2b, `S2-2B-CONTRACT.md` §1):
/// `dv` the value the credit added, `supply` the units outstanding and `v0`
/// the vault's value before the credit. With no units out the depositor
/// takes the vault (`dv + v0`); units of an empty vault are worth nothing
/// against a deposit (`dv × supply`). Saturates at `u64::MAX`.
pub fn minted(dv: u128, supply: u64, v0: u128) -> u64 {
    let m = if supply == 0 {
        dv.saturating_add(v0)
    } else if v0 == 0 {
        dv.saturating_mul(supply as u128)
    } else {
        dv.saturating_mul(supply as u128) / v0
    };
    m.min(u64::MAX as u128) as u64
}

/// The basket `amount` of `supply` units withdraw from `stores` (milli):
/// `⌊store_r × amount / supply⌋` in whole units, as milli (2b).
pub fn basket(stores: &[Milli; RESOURCES], amount: u64, supply: u64) -> [Milli; RESOURCES] {
    let mut out = [0; RESOURCES];
    if supply == 0 || amount > supply {
        return out;
    }
    for (o, &s) in out.iter_mut().zip(stores.iter()) {
        let take = s.max(0) as u128 * amount as u128 / supply as u128;
        *o = (take / 1_000 * 1_000) as Milli;
    }
    out
}

/// A vault's receipts period (2c, `S2-2C-CONTRACT.md` §2–§3). Days are
/// stored **plus one** (0: never), as in the Vault and the Lot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Period {
    /// The day (+1) whose claims `claims` holds.
    pub claim_day: u32,
    /// The day (+1) the vault last rolled; `ratio` and `res` hold for it.
    pub res_day: u32,
    /// Milli claimed on `claim_day`, per resource.
    pub claims: [u64; RESOURCES],
    /// Milli still reserved on `res_day`, per resource.
    pub res: [u64; RESOURCES],
    /// Parts per million granted on `res_day` to the claims of the day
    /// before.
    pub ratio: [u32; RESOURCES],
}

impl Period {
    /// Whether the vault ever had a claim (a vault without never rolls).
    pub const fn active(&self) -> bool {
        self.claim_day != 0 || self.res_day != 0
    }

    /// The roll at the first touch of day `today` (a real day): yesterday's
    /// claims become today's ratio and reservation against `stock`; claims
    /// start over. Idempotent within a day.
    pub fn roll(&mut self, today: u32, stock: &[Milli; RESOURCES]) {
        let t = today.saturating_add(1);
        if self.res_day != t {
            let yesterday = self.claim_day != 0 && self.claim_day.saturating_add(1) == t;
            for (r, &st) in stock.iter().enumerate() {
                let (c, s) = (self.claims[r], st.max(0) as u64);
                if yesterday && c > 0 {
                    let q = s as u128 * RATIO_ONE as u128 / c as u128;
                    self.ratio[r] = q.min(RATIO_ONE as u128) as u32;
                    self.res[r] = s.min(c);
                } else {
                    self.ratio[r] = 0;
                    self.res[r] = 0;
                }
            }
            self.res_day = t;
        }
        if self.claim_day != t {
            self.claims = [0; RESOURCES];
            self.claim_day = t;
        }
    }

    /// What the owner may send of resource `r` on day `today` (the stock
    /// less today's reservation).
    pub fn available(&self, today: u32, r: usize, stock: Milli) -> Milli {
        let res = if self.res_day == today.saturating_add(1) {
            self.res[r] as Milli
        } else {
            0
        };
        stock.saturating_sub(res).max(0)
    }
}

/// A claim's grant at `ratio` (parts per million), in whole units (milli).
pub fn grant(claim: u64, ratio: u32) -> u64 {
    let g = claim as u128 * ratio.min(RATIO_ONE) as u128 / RATIO_ONE as u128;
    (g / 1_000 * 1_000) as u64
}

/// Appends this module's tables to the S2 ruleset hash input.
pub fn write_tables(out: &mut alloc::vec::Vec<u8>) {
    out.extend_from_slice(&TICKET_VERSION.to_le_bytes());
    out.extend_from_slice(&KINDS);
    out.push(MAX_OPEN_ISSUES);
    out.extend_from_slice(&MAX_SUPPLY.to_le_bytes());
    out.extend_from_slice(&RATIO_ONE.to_le_bytes());
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
    fn minting() {
        assert_eq!(minted(100, 0, 0), 100, "the first deposit");
        assert_eq!(minted(100, 0, 3), 103, "takes the remainder");
        assert_eq!(minted(50, 200, 100), 100, "at the vault's price");
        assert_eq!(minted(1, 3, 2), 1, "rounds down");
        assert_eq!(minted(10, 7, 0), 70, "units of an empty vault");
        assert_eq!(minted(u128::MAX / 2, u64::MAX, 1), u64::MAX);
    }

    #[test]
    fn the_basket() {
        let mut s = [0i64; RESOURCES];
        s[0] = 1_000_000; // 1000 food
        s[3] = 7_500; // 7.5 ore
        let b = basket(&s, 1, 3);
        assert_eq!(b[0], 333_000);
        assert_eq!(b[3], 2_000, "whole units");
        assert_eq!(basket(&s, 3, 3)[3], 7_000, "the fraction stays");
        assert_eq!(basket(&s, 4, 3), [0; RESOURCES]);
        assert_eq!(basket(&s, 1, 0), [0; RESOURCES]);
    }

    #[test]
    fn the_period_rolls_at_the_day_boundary() {
        let mut p = Period::default();
        assert!(!p.active());
        let mut stock = [0i64; RESOURCES];
        stock[3] = 30_000;
        // Day 0: two claims of 20 ore.
        p.roll(0, &stock);
        assert_eq!((p.claim_day, p.res_day), (1, 1));
        p.claims[3] += 40_000;
        p.roll(0, &stock);
        assert_eq!(p.claims[3], 40_000, "idempotent within the day");
        // Day 1: 30 of 40 claimed: 3/4.
        p.roll(1, &stock);
        assert_eq!((p.ratio[3], p.res[3], p.claims[3]), (750_000, 30_000, 0));
        assert_eq!(grant(20_000, p.ratio[3]), 15_000);
        assert_eq!(p.available(1, 3, 30_000), 0);
        assert_eq!(p.available(2, 3, 30_000), 30_000, "the reservation lapses");
        // Enough stock: a ratio of one.
        p.claims[3] = 10_000;
        p.roll(2, &stock);
        assert_eq!((p.ratio[3], p.res[3]), (RATIO_ONE, 10_000));
        // A day skipped: yesterday's claims lapse.
        p.claims[3] = 10_000;
        p.roll(4, &stock);
        assert_eq!((p.ratio[3], p.res[3]), (0, 0));
    }

    #[test]
    fn grants_are_whole_units() {
        assert_eq!(grant(20_000, RATIO_ONE), 20_000);
        assert_eq!(grant(1_999, RATIO_ONE), 1_000);
        assert_eq!(grant(10_000, 333_333), 3_000);
        assert_eq!(grant(10_000, 0), 0);
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
