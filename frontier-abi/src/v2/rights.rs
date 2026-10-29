//! **Proposal (workstream 02-rights, not adopted):** the facility-use
//! right, first kind only: **WorkshopUse**. Contract text:
//! `workstreams/02-rights/03-CONTRACT.ja.md`. Nothing here is allocated in the
//! shared ABI: the tags, error codes, seed tag and layout below are
//! *proposed* values kept out of [`crate::v2::Ix`], [`crate::v2::CqError`]
//! and [`crate::v2::layout::AccountKind`] so that no existing table, vector
//! or exhaustive match changes. The integrator allocates them on adoption.
//!
//! A Grant lets the **grantee** Citizen run the **issuer**'s workshop
//! holding (the *facility*, pinned with its generation) with the
//! grantee's own ore and wood, taken from and returned to the grantee's
//! *station* holding in the same Province, within `max_units` arms in all,
//! `max_uses` consumed reservations and until `expires_ts`. No key and no
//! ownership moves: the grantee signs with its own wallet or its own
//! session; the issuer's keys are never used after IssueGrant.
//!
//! Two phases, so a multi-step plan can hold its inputs and outputs:
//!
//! 1. **ReserveUse(units)**: `units × ORE_PER_ARM` ore and `units ×
//!    WOOD_PER_ARM` wood leave the station, `units` arms leave the
//!    facility; all three are held in the Grant (escrow). At most one
//!    reservation is open per Grant.
//! 2. **ConsumeUse**: the escrowed arms go to the station, the escrowed ore
//!    and wood to the facility (its workshops' inputs). Final: nothing a
//!    consume moved is ever returned.
//!
//! **ReleaseUse** undoes an open reservation (both sides back) — by the
//! grantee at any time, by anyone once the Grant is expired or a pinned
//! holding has changed generation. **RevokeGrant** (issuer) ends the Grant:
//! an open reservation is undone as by ReleaseUse, the unused quota is
//! void, consumed uses stay consumed. **CloseGrant** returns the rent once
//! nothing is escrowed.
//!
//! Capacity: the arms come out of the facility's own store, which only its
//! workshops (or the owner's own deliveries) fill, so a Grant never makes
//! arms the workshops did not make (no Sybil self-grant multiplies output).

use crate::addr::{AddrCtx, Seed};
use crate::bytes::{Cursor, Writer};
use crate::error::FrontierError;
use crate::ix::Wire;

// ------------------------------------------------------------ tags

/// Proposed tags (outside every allocated and reserved v2 tag).
pub mod tag {
    pub const ISSUE_GRANT: u8 = 0xD0;
    pub const RESERVE_USE: u8 = 0xD1;
    pub const CONSUME_USE: u8 = 0xD2;
    pub const RELEASE_USE: u8 = 0xD3;
    pub const REVOKE_GRANT: u8 = 0xD4;
    pub const CLOSE_GRANT: u8 = 0xD5;
}

/// Whether `t` is one of the proposed rights tags.
pub const fn is_rights_tag(t: u8) -> bool {
    t >= tag::ISSUE_GRANT && t <= tag::CLOSE_GRANT
}

// ------------------------------------------------------------ errors

/// Proposed error codes (200–211; an unallocated range, far from the S1
/// codes so a parallel allocation cannot collide).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u32)]
pub enum RightsError {
    /// The account is not a Grant of this program and season at its
    /// canonical address, or its fields contradict the accounts named.
    BadGrant = 200,
    /// The signer is not the Citizen the Grant names in that role.
    NotGrantee = 201,
    /// The Grant was revoked.
    Revoked = 202,
    /// `now ≥ expires_ts`.
    Expired = 203,
    /// `max_units` or `max_uses` would be passed.
    QuotaExceeded = 204,
    /// A reservation is already open (one at a time).
    ReservationOpen = 205,
    /// ConsumeUse or ReleaseUse with no open reservation.
    NoReservation = 206,
    /// The facility or station holding is not the generation (or owner)
    /// the Grant pins: captured, released or refounded since.
    StaleHolding = 207,
    /// IssueGrant: the facility has no workshop.
    NoWorkshop = 208,
    /// IssueGrant: the station is not the grantee's live holding in the
    /// facility's Province, or names the facility itself.
    BadStation = 209,
    /// IssueGrant terms out of range (zero quota, past or too-far expiry,
    /// issuer granting itself).
    BadTerms = 210,
    /// CloseGrant while the Grant may still be used or holds escrow.
    StillLive = 211,
}

impl RightsError {
    pub const ALL: [RightsError; 12] = {
        use RightsError::*;
        [
            BadGrant,
            NotGrantee,
            Revoked,
            Expired,
            QuotaExceeded,
            ReservationOpen,
            NoReservation,
            StaleHolding,
            NoWorkshop,
            BadStation,
            BadTerms,
            StillLive,
        ]
    };

    pub const fn code(self) -> u32 {
        self as u32
    }

    pub fn from_code(code: u32) -> Option<RightsError> {
        Self::ALL.iter().copied().find(|e| e.code() == code)
    }
}

// ------------------------------------------------------------ terms

/// The only kind of the first version.
pub const KIND_WORKSHOP_USE: u8 = 1;
/// Grant states.
pub const STATE_ACTIVE: u8 = 1;
pub const STATE_REVOKED: u8 = 2;
/// The longest a Grant may run from its issue (as a session, 30 days).
pub const MAX_GRANT_SECS: i64 = 30 * 86_400;
/// Most arms one reservation may move (bounds the escrow arithmetic).
pub const MAX_UNITS_PER_USE: u32 = 10_000;

// ------------------------------------------------------------ address

/// The Grant seed tag (free in v1 and v2).
pub const GRANT: [u8; 2] = *b"gr";
/// Raw key length of a Grant (`issuer_tag u64, nonce u32`).
pub const GRANT_RAW_LEN: usize = 12;

/// `gr‖hex(le64 issuer_tag ‖ le32 nonce)`.
pub fn grant_seed(issuer_tag: u64, nonce: u32) -> Seed {
    let mut raw = [0u8; GRANT_RAW_LEN];
    raw[..8].copy_from_slice(&issuer_tag.to_le_bytes());
    raw[8..].copy_from_slice(&nonce.to_le_bytes());
    Seed::new(GRANT, &raw)
}

/// The Grant address of the issuer's `nonce` in the season of `ctx`: a
/// with-seed address of the Season PDA, so a Grant of another season (or
/// program) can never sit at it.
pub fn grant(ctx: &AddrCtx, issuer_tag: u64, nonce: u32) -> [u8; 32] {
    ctx.of(&grant_seed(issuer_tag, nonce))
}

// ------------------------------------------------------------ layout

/// Grant (272 B), not chained (its history is the program's log).
pub mod layout {
    pub const MAGIC: [u8; 8] = *b"PSF2GRNT";
    pub const VERSION_1: u16 = 1;
    pub const SEASON_ID: usize = 8; // u64
    pub const VERSION: usize = 16; // u16
    pub const KIND: usize = 18; // u8
    pub const STATE: usize = 19; // u8
    pub const FACILITY_GEN: usize = 20; // u8
    pub const STATION_GEN: usize = 21; // u8
    pub const FACILITY_SITE: usize = 22; // u8
    pub const STATION_SITE: usize = 23; // u8
    pub const P: usize = 24; // i16
    pub const Q: usize = 26; // i16
    pub const NONCE: usize = 28; // u32
    pub const ISSUER_CITIZEN: usize = 32; // [u8;32]
    pub const GRANTEE_CITIZEN: usize = 64; // [u8;32]
    pub const FACILITY: usize = 96; // [u8;32]
    pub const STATION: usize = 128; // [u8;32]
    pub const ISSUER_TAG: usize = 160; // u64
    pub const EXPIRES_TS: usize = 168; // i64
    pub const ISSUED_TS: usize = 176; // i64
    pub const MAX_USES: usize = 184; // u16
    pub const USES: usize = 186; // u16, consumed reservations
    pub const MAX_UNITS: usize = 188; // u32
    pub const UNITS_CONSUMED: usize = 192; // u32
    pub const OPEN_UNITS: usize = 196; // u32, 0 = none open
    pub const OPEN_TS: usize = 200; // i64
    pub const OPEN_ORE: usize = 208; // i64 milli
    pub const OPEN_WOOD: usize = 216; // i64 milli
    pub const OPEN_ARMS: usize = 224; // i64 milli
    pub const REVOKED_TS: usize = 232; // i64
    pub const RENT_TO: usize = 240; // [u8;32]
    pub const SIZE: usize = 272;
}

// ------------------------------------------------------------ instruction data

macro_rules! ix_rights {
    ($( $(#[$m:meta])* $name:ident = $tag:path { $( $f:ident : $t:ty ),* $(,)? } )*) => {$(
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct $name { $( pub $f: $t, )* }

        impl $name {
            pub const TAG: u8 = $tag;
            pub const LEN: usize = 1 $( + <$t as Wire>::N )*;

            pub fn to_bytes(&self) -> [u8; Self::LEN] {
                let mut b = [0u8; Self::LEN];
                let mut w = Writer::new(&mut b);
                w.u8(Self::TAG);
                $( Wire::put(&self.$f, &mut w); )*
                let _ = w.finish();
                b
            }

            #[allow(unused_mut, unused_variables)]
            pub fn decode(d: &[u8]) -> Result<Self, FrontierError> {
                if d.len() != Self::LEN || d[0] != Self::TAG {
                    return Err(FrontierError::BadData);
                }
                let mut c = Cursor::new(&d[1..]);
                Ok($name { $( $f: <$t as Wire>::get(&mut c).ok_or(FrontierError::BadData)?, )* })
            }
        }
    )*};
}

ix_rights! {
    /// 0xD0 (P, issuer's **wallet**): `[actor s] [payer s,w] [season r]
    /// [issuer_citizen w] [facility r] [province r] [grantee_citizen r]
    /// [station r] [grant w] [system]`.
    IssueGrant = tag::ISSUE_GRANT {
        nonce: u32,
        kind: u8,
        max_uses: u16,
        max_units: u32,
        expires_ts: i64,
    }
    /// 0xD1 (P, grantee's wallet or session): `[actor s] [payer s,w]
    /// [season r] [grantee_citizen w] [grant w] [facility w] [station w]
    /// [province r]`. `1 ≤ units ≤ MAX_UNITS_PER_USE`.
    ReserveUse = tag::RESERVE_USE { units: u32 }
    /// 0xD2 (P, grantee): same accounts as ReserveUse.
    ConsumeUse = tag::CONSUME_USE {}
    /// 0xD3: `[actor s] [season r] [grantee_citizen r] [grant w]
    /// [facility w] [station w] [province r]`; the grantee (wallet or
    /// live session) any time, any signer once expired or stale.
    ReleaseUse = tag::RELEASE_USE {}
    /// 0xD4 (P, issuer's wallet or session): `[actor s] [payer s,w]
    /// [season r] [issuer_citizen w] [grant w] [facility w] [station w]
    /// [province r]`.
    RevokeGrant = tag::REVOKE_GRANT {}
    /// 0xD5: `[actor s] [season r] [grant w] [rent_to w]`, any signer,
    /// once no reservation is open and the Grant can no longer be used
    /// (revoked, expired or its quota spent); the rent goes to `RENT_TO`.
    CloseGrant = tag::CLOSE_GRANT {}
}

// ------------------------------------------------------------ pure rules

/// The quota check of ReserveUse: `units` in `1..=MAX_UNITS_PER_USE`, one
/// more consumed use within `max_uses`, the consumed units plus `units`
/// within `max_units`.
pub fn quota_allows(
    max_uses: u16,
    uses: u16,
    max_units: u32,
    units_consumed: u32,
    units: u32,
) -> Result<(), RightsError> {
    if units == 0 || units > MAX_UNITS_PER_USE {
        return Err(RightsError::QuotaExceeded);
    }
    if uses >= max_uses {
        return Err(RightsError::QuotaExceeded);
    }
    match units_consumed.checked_add(units) {
        Some(t) if t <= max_units => Ok(()),
        _ => Err(RightsError::QuotaExceeded),
    }
}

/// IssueGrant's terms: kind known, quotas non-zero, `now < expires_ts ≤ now
/// + MAX_GRANT_SECS`.
pub fn terms_ok(kind: u8, max_uses: u16, max_units: u32, expires_ts: i64, now: i64) -> bool {
    kind == KIND_WORKSHOP_USE
        && max_uses > 0
        && max_units > 0
        && expires_ts > now
        && expires_ts <= now.saturating_add(MAX_GRANT_SECS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_and_codes_do_not_collide_with_v2() {
        for t in tag::ISSUE_GRANT..=tag::CLOSE_GRANT {
            assert!(crate::v2::Ix::from_tag(t).is_none(), "{t:#x}");
            assert!(is_rights_tag(t));
        }
        assert!(!is_rights_tag(0xC0) && !is_rights_tag(0xD6));
        for e in RightsError::ALL {
            assert!(crate::v2::Code::from_code(e.code()).is_none(), "{e:?}");
            assert_eq!(RightsError::from_code(e.code()), Some(e));
        }
    }

    #[test]
    fn seed_fits_and_differs_by_season() {
        let s = grant_seed(u64::MAX, u32::MAX);
        assert_eq!(s.as_bytes().len(), 2 + 2 * GRANT_RAW_LEN);
        let a = AddrCtx {
            season: [1; 32],
            program: [9; 32],
        };
        let b = AddrCtx {
            season: [2; 32],
            program: [9; 32],
        };
        assert_ne!(grant(&a, 7, 0), grant(&b, 7, 0));
        assert_ne!(grant(&a, 7, 0), grant(&a, 7, 1));
    }

    #[test]
    fn data_round_trips() {
        let x = IssueGrant {
            nonce: 3,
            kind: KIND_WORKSHOP_USE,
            max_uses: 3,
            max_units: 30,
            expires_ts: 99,
        };
        assert_eq!(IssueGrant::decode(&x.to_bytes()), Ok(x));
        assert_eq!(IssueGrant::LEN, 1 + 4 + 1 + 2 + 4 + 8);
        let r = ReserveUse { units: 5 };
        assert_eq!(ReserveUse::decode(&r.to_bytes()), Ok(r));
        assert!(ReserveUse::decode(&ConsumeUse {}.to_bytes()).is_err());
    }

    #[test]
    fn quota_and_terms() {
        assert_eq!(quota_allows(3, 0, 30, 0, 10), Ok(()));
        assert_eq!(quota_allows(3, 2, 30, 20, 10), Ok(()));
        assert_eq!(
            quota_allows(3, 2, 30, 20, 11),
            Err(RightsError::QuotaExceeded)
        );
        assert_eq!(
            quota_allows(3, 3, 30, 0, 1),
            Err(RightsError::QuotaExceeded)
        );
        assert_eq!(
            quota_allows(3, 0, 30, 0, 0),
            Err(RightsError::QuotaExceeded)
        );
        assert_eq!(
            quota_allows(1, 0, u32::MAX, u32::MAX, 1),
            Err(RightsError::QuotaExceeded)
        );
        assert!(terms_ok(1, 1, 1, 101, 100));
        assert!(!terms_ok(2, 1, 1, 101, 100));
        assert!(!terms_ok(1, 0, 1, 101, 100));
        assert!(!terms_ok(1, 1, 1, 100, 100));
        assert!(!terms_ok(1, 1, 1, 100 + MAX_GRANT_SECS + 1, 100));
    }
}
