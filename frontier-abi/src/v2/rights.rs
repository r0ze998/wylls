//! **Proposal (workstream 02-rights, not adopted):** the first right of
//! the rights layer, **the workshop-stock swap** (`KIND_STOCK_SWAP`).
//! Contract text: `workstreams/02-rights/03-CONTRACT.ja.md`. Nothing here
//! is allocated in the shared ABI: the tags, error codes, seed tag and
//! layout below are *proposed* values kept out of [`crate::v2::Ix`],
//! [`crate::v2::CqError`] and [`crate::v2::layout::AccountKind`] so that
//! no existing table, vector or exhaustive match changes. The integrator
//! allocates them on adoption.
//!
//! **What the right is.** The grantee may exchange its own ore and wood
//! for arms **the issuer's workshop holding (the *facility*) has already
//! made and holds in its store**, at the workshop ratio (`ORE_PER_ARM`,
//! `WOOD_PER_ARM` per arm), through the grantee's *station* holding in the
//! same Province, within `max_units` arms and `max_swaps` executed swaps in
//! all and until `expires_ts`. No key and no ownership of a place moves:
//! the grantee signs with its own wallet or its own session; the issuer's
//! keys are not used after IssueGrant.
//!
//! **What it is not.** It does not run the workshop (there is no "process
//! once" in the program: workshops convert their own holding's ore and
//! wood continuously, and this right leaves that conversion exactly as it
//! is), and it does not reserve future production capacity. With no arms
//! in the facility's store, ReserveSwap is refused (`Insufficient`): there
//! is no queue and no waiting state; the Grant stays usable until it
//! expires or is revoked, and the grantee may try again once the
//! workshops have made more.
//!
//! Two phases, so a multi-step plan can hold both sides:
//!
//! 1. **ReserveSwap(units)**: `units × ORE_PER_ARM` ore and `units ×
//!    WOOD_PER_ARM` wood leave the station, `units` arms leave the
//!    facility; all three are recorded in the Grant (escrow: in no
//!    holding's store, so neither production nor any other action can use
//!    them). At most one reservation is open per Grant.
//! 2. **ExecuteSwap**: the escrowed arms go to the station, the escrowed
//!    ore and wood to the facility's store. Final: nothing an executed
//!    swap moved is ever returned.
//!
//! **ReleaseSwap** undoes an open reservation — by the grantee at any
//! time, by anyone once the Grant is expired or a pinned holding is stale.
//! **RevokeGrant** (issuer) ends the Grant: an open reservation is undone
//! as by ReleaseSwap, the unused quota is void, executed swaps stay.
//! Each side goes back to the holding it came from as that holding stands
//! now; a side whose holding no longer exists **stays in the Grant**
//! (recorded, not credited anywhere, not burned) until a rule for it is
//! decided. **CloseGrant** returns the rent once nothing is escrowed.
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
    pub const RESERVE_SWAP: u8 = 0xD1;
    pub const EXECUTE_SWAP: u8 = 0xD2;
    pub const RELEASE_SWAP: u8 = 0xD3;
    pub const REVOKE_GRANT: u8 = 0xD4;
    pub const CLOSE_GRANT: u8 = 0xD5;
}

/// Whether `t` is one of the proposed rights tags.
pub const fn is_rights_tag(t: u8) -> bool {
    t >= tag::ISSUE_GRANT && t <= tag::CLOSE_GRANT
}

// ------------------------------------------------------------ errors

/// Proposed error codes (200–213; an unallocated range, far from the S1
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
    /// `max_units` or `max_swaps` would be passed.
    QuotaExceeded = 204,
    /// A reservation is already open (one at a time).
    ReservationOpen = 205,
    /// ExecuteSwap or ReleaseSwap with no open reservation.
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
    /// ReleaseSwap that could return nothing: no live holding remains for
    /// any escrowed side (the escrow stays in the Grant).
    ReturnBlocked = 212,
    /// ReserveSwap or ExecuteSwap whose `seq` is not the Grant's executed
    /// swap count: a retry of a step that already happened, or a step of
    /// another plan.
    SeqMismatch = 213,
}

impl RightsError {
    pub const ALL: [RightsError; 14] = {
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
            ReturnBlocked,
            SeqMismatch,
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

/// The only kind of the first version: the workshop-stock swap.
pub const KIND_STOCK_SWAP: u8 = 1;
/// Grant states.
pub const STATE_ACTIVE: u8 = 1;
pub const STATE_REVOKED: u8 = 2;
/// The longest a Grant may run from its issue (as a session, 30 days).
pub const MAX_GRANT_SECS: i64 = 30 * 86_400;
/// Most arms one reservation may move (bounds the escrow arithmetic).
pub const MAX_UNITS_PER_SWAP: u32 = 10_000;

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
    pub const MAX_SWAPS: usize = 184; // u16
    pub const SWAPS: usize = 186; // u16, executed swaps
    pub const MAX_UNITS: usize = 188; // u32
    pub const UNITS_SWAPPED: usize = 192; // u32, executed units
    pub const OPEN_UNITS: usize = 196; // u32, 0 = no escrow
    pub const OPEN_TS: usize = 200; // i64
    pub const OPEN_ORE: usize = 208; // i64 milli, station side
    pub const OPEN_WOOD: usize = 216; // i64 milli, station side
    pub const OPEN_ARMS: usize = 224; // i64 milli, facility side
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
        max_swaps: u16,
        max_units: u32,
        expires_ts: i64,
    }
    /// 0xD1 (P, grantee's wallet or session): `[actor s] [payer s,w]
    /// [season r] [grantee_citizen w] [grant w] [facility w] [station w]
    /// [province r]`. `1 ≤ units ≤ MAX_UNITS_PER_SWAP`; `seq` = the
    /// Grant's `SWAPS` (executed swaps) the caller saw, so a rebuilt retry
    /// of a swap that already went through is refused (`SeqMismatch`).
    ReserveSwap = tag::RESERVE_SWAP { units: u32, seq: u16 }
    /// 0xD2 (P, grantee): same accounts as ReserveSwap; `seq` as there (the
    /// reservation being executed).
    ExecuteSwap = tag::EXECUTE_SWAP { seq: u16 }
    /// 0xD3: `[actor s] [season r] [grantee_citizen r] [grant w]
    /// [facility w] [station w] [province r]`; the grantee (wallet or
    /// live session) any time, any signer once expired or stale.
    ReleaseSwap = tag::RELEASE_SWAP {}
    /// 0xD4 (P, issuer's wallet or session): `[actor s] [payer s,w]
    /// [season r] [issuer_citizen w] [grant w] [facility w] [station w]
    /// [province r]`.
    RevokeGrant = tag::REVOKE_GRANT {}
    /// 0xD5: `[actor s] [season r] [grant w] [rent_to w]`, any signer,
    /// once nothing is escrowed and the Grant can no longer be used
    /// (revoked, expired or its quota spent); the rent goes to `RENT_TO`.
    CloseGrant = tag::CLOSE_GRANT {}
}

// ------------------------------------------------------------ pure rules

/// The quota check of ReserveSwap: `units` in `1..=MAX_UNITS_PER_SWAP`,
/// one more executed swap within `max_swaps`, the executed units plus
/// `units` within `max_units`.
pub fn quota_allows(
    max_swaps: u16,
    swaps: u16,
    max_units: u32,
    units_swapped: u32,
    units: u32,
) -> Result<(), RightsError> {
    if units == 0 || units > MAX_UNITS_PER_SWAP {
        return Err(RightsError::QuotaExceeded);
    }
    if swaps >= max_swaps {
        return Err(RightsError::QuotaExceeded);
    }
    match units_swapped.checked_add(units) {
        Some(t) if t <= max_units => Ok(()),
        _ => Err(RightsError::QuotaExceeded),
    }
}

/// IssueGrant's terms: kind known, quotas non-zero, `now < expires_ts ≤ now
/// + MAX_GRANT_SECS`.
pub fn terms_ok(kind: u8, max_swaps: u16, max_units: u32, expires_ts: i64, now: i64) -> bool {
    kind == KIND_STOCK_SWAP
        && max_swaps > 0
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
            kind: KIND_STOCK_SWAP,
            max_swaps: 3,
            max_units: 30,
            expires_ts: 99,
        };
        assert_eq!(IssueGrant::decode(&x.to_bytes()), Ok(x));
        assert_eq!(IssueGrant::LEN, 1 + 4 + 1 + 2 + 4 + 8);
        let r = ReserveSwap { units: 5, seq: 2 };
        assert_eq!(ReserveSwap::decode(&r.to_bytes()), Ok(r));
        assert_eq!(ReserveSwap::LEN, 1 + 4 + 2);
        assert!(ReserveSwap::decode(&ExecuteSwap { seq: 2 }.to_bytes()).is_err());
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
