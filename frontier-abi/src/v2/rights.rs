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
/// The bit a `rights-experimental` build sets in its `PROGRAM_VERSION`
/// (`0x2000 | PROGRAM_VERSION_S1`), so its Seasons never mix with
/// production ones. **Provisional** (workstream 4 fixes program versions):
/// disjoint from the NFT build's `0x8000` and the wide build's `0x4000`.
pub const RIGHTS_EXPERIMENTAL_VERSION_BIT: u16 = 0x2000;

/// The program version of a `rights-experimental` S1 build alone.
pub const PROGRAM_VERSION_RIGHTS_S1: u16 =
    crate::v2::presets::PROGRAM_VERSION_S1 | RIGHTS_EXPERIMENTAL_VERSION_BIT;

/// Whether `pv` is a program version that runs the Grant instructions
/// (the S1 rules with the rights bit; the bits of other experimental
/// builds may be set beside it, which no verifier models yet).
pub const fn runs_grants(pv: u16) -> bool {
    pv & RIGHTS_EXPERIMENTAL_VERSION_BIT != 0
        && pv & 0x00ff == crate::v2::presets::PROGRAM_VERSION_S1
}

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

// ------------------------------------------------------------ PS2 records

/// The Grant's PS2 records (kinds `GRANT_ISSUED` … `GRANT_CLOSED` of
/// [`crate::v2::log::CqKind`], **provisional codes 114–119**, workstream 4's allocation rev 3): one shared
/// encoding for the program that logs them and the verifier that replays
/// them. Every record is keyed by the Grant (`issuer_tag ‖ nonce`).
pub mod record {
    use crate::bytes::{rd_i32, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8};
    use crate::v2::log::CqKind;

    pub const ISSUED: CqKind = CqKind::GRANT_ISSUED;
    pub const RESERVED: CqKind = CqKind::SWAP_RESERVED;
    pub const EXECUTED: CqKind = CqKind::SWAP_EXECUTED;
    pub const RELEASED: CqKind = CqKind::SWAP_RELEASED;
    pub const REVOKED: CqKind = CqKind::GRANT_REVOKED;
    pub const CLOSED: CqKind = CqKind::GRANT_CLOSED;

    /// Who undid an escrow (`by` of RELEASED and REVOKED).
    pub mod by {
        pub const GRANTEE: u8 = 0;
        pub const AFTER_EXPIRY: u8 = 1;
        pub const STALE_HOLDING: u8 = 2;
        pub const ISSUER: u8 = 3;
    }

    /// Whether `k` is one of the Grant's record kinds.
    pub fn is_rights(k: CqKind) -> bool {
        matches!(
            k,
            CqKind::GRANT_ISSUED
                | CqKind::SWAP_RESERVED
                | CqKind::SWAP_EXECUTED
                | CqKind::SWAP_RELEASED
                | CqKind::GRANT_REVOKED
                | CqKind::GRANT_CLOSED
        )
    }

    /// The record key: the Grant's issuer tag and nonce.
    pub fn key(issuer_tag: u64, nonce: u32) -> [u8; 12] {
        let mut k = [0u8; 12];
        k[..8].copy_from_slice(&issuer_tag.to_le_bytes());
        k[8..].copy_from_slice(&nonce.to_le_bytes());
        k
    }

    /// `(issuer_tag, nonce)` of a record key.
    pub fn of_key(k: &[u8]) -> Option<(u64, u32)> {
        Some((rd_u64(k, 0)?, rd_u32(k, 8)?))
    }

    /// GRANT_ISSUED's payload (42 B).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Issued {
        pub grantee_tag: u64,
        pub p: i32,
        pub q: i32,
        pub facility_site: u8,
        pub facility_gen: u8,
        pub station_site: u8,
        pub station_gen: u8,
        pub max_swaps: u16,
        pub max_units: u32,
        pub expires_ts: i64,
        pub rent: u64,
    }

    impl Issued {
        pub const LEN: usize = 42;
        pub fn to_bytes(&self) -> [u8; Self::LEN] {
            let mut b = [0u8; Self::LEN];
            b[0..8].copy_from_slice(&self.grantee_tag.to_le_bytes());
            b[8..12].copy_from_slice(&self.p.to_le_bytes());
            b[12..16].copy_from_slice(&self.q.to_le_bytes());
            b[16] = self.facility_site;
            b[17] = self.facility_gen;
            b[18] = self.station_site;
            b[19] = self.station_gen;
            b[20..22].copy_from_slice(&self.max_swaps.to_le_bytes());
            b[22..26].copy_from_slice(&self.max_units.to_le_bytes());
            b[26..34].copy_from_slice(&self.expires_ts.to_le_bytes());
            b[34..42].copy_from_slice(&self.rent.to_le_bytes());
            b
        }
        pub fn from_bytes(b: &[u8]) -> Option<Issued> {
            if b.len() != Self::LEN {
                return None;
            }
            Some(Issued {
                grantee_tag: rd_u64(b, 0)?,
                p: rd_i32(b, 8)?,
                q: rd_i32(b, 12)?,
                facility_site: rd_u8(b, 16)?,
                facility_gen: rd_u8(b, 17)?,
                station_site: rd_u8(b, 18)?,
                station_gen: rd_u8(b, 19)?,
                max_swaps: rd_u16(b, 20)?,
                max_units: rd_u32(b, 22)?,
                expires_ts: rd_i64(b, 26)?,
                rent: rd_u64(b, 34)?,
            })
        }
    }

    /// SWAP_RESERVED's and SWAP_EXECUTED's payload (48 B): what moved.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Swap {
        pub grantee_tag: u64,
        pub p: i32,
        pub q: i32,
        pub facility_site: u8,
        pub station_site: u8,
        pub seq: u16,
        pub units: u32,
        /// Milli-units: the station's ore and wood, the facility's arms.
        pub ore: i64,
        pub wood: i64,
        pub arms: i64,
    }

    impl Swap {
        pub const LEN: usize = 48;
        pub fn to_bytes(&self) -> [u8; Self::LEN] {
            let mut b = [0u8; Self::LEN];
            b[0..8].copy_from_slice(&self.grantee_tag.to_le_bytes());
            b[8..12].copy_from_slice(&self.p.to_le_bytes());
            b[12..16].copy_from_slice(&self.q.to_le_bytes());
            b[16] = self.facility_site;
            b[17] = self.station_site;
            b[18..20].copy_from_slice(&self.seq.to_le_bytes());
            b[20..24].copy_from_slice(&self.units.to_le_bytes());
            b[24..32].copy_from_slice(&self.ore.to_le_bytes());
            b[32..40].copy_from_slice(&self.wood.to_le_bytes());
            b[40..48].copy_from_slice(&self.arms.to_le_bytes());
            b
        }
        pub fn from_bytes(b: &[u8]) -> Option<Swap> {
            if b.len() != Self::LEN {
                return None;
            }
            Some(Swap {
                grantee_tag: rd_u64(b, 0)?,
                p: rd_i32(b, 8)?,
                q: rd_i32(b, 12)?,
                facility_site: rd_u8(b, 16)?,
                station_site: rd_u8(b, 17)?,
                seq: rd_u16(b, 18)?,
                units: rd_u32(b, 20)?,
                ore: rd_i64(b, 24)?,
                wood: rd_i64(b, 32)?,
                arms: rd_i64(b, 40)?,
            })
        }
    }

    /// SWAP_RELEASED's and GRANT_REVOKED's payload (59 B): what went back
    /// and what stays in the Grant.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Undo {
        pub by: u8,
        pub p: i32,
        pub q: i32,
        pub facility_site: u8,
        pub station_site: u8,
        /// Milli-units returned: ore and wood to the station, arms to the
        /// facility.
        pub returned: [i64; 3],
        /// Milli-units still escrowed (no live holding to go back to).
        pub kept: [i64; 3],
    }

    impl Undo {
        pub const LEN: usize = 59;
        pub fn to_bytes(&self) -> [u8; Self::LEN] {
            let mut b = [0u8; Self::LEN];
            b[0] = self.by;
            b[1..5].copy_from_slice(&self.p.to_le_bytes());
            b[5..9].copy_from_slice(&self.q.to_le_bytes());
            b[9] = self.facility_site;
            b[10] = self.station_site;
            for i in 0..3 {
                b[11 + 8 * i..19 + 8 * i].copy_from_slice(&self.returned[i].to_le_bytes());
                b[35 + 8 * i..43 + 8 * i].copy_from_slice(&self.kept[i].to_le_bytes());
            }
            b
        }
        pub fn from_bytes(b: &[u8]) -> Option<Undo> {
            if b.len() != Self::LEN {
                return None;
            }
            let mut returned = [0i64; 3];
            let mut kept = [0i64; 3];
            for i in 0..3 {
                returned[i] = rd_i64(b, 11 + 8 * i)?;
                kept[i] = rd_i64(b, 35 + 8 * i)?;
            }
            Some(Undo {
                by: rd_u8(b, 0)?,
                p: rd_i32(b, 1)?,
                q: rd_i32(b, 5)?,
                facility_site: rd_u8(b, 9)?,
                station_site: rd_u8(b, 10)?,
                returned,
                kept,
            })
        }
    }

    /// GRANT_CLOSED's payload (16 B): the rent and the first 8 bytes of
    /// its recipient.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Closed {
        pub rent: u64,
        pub rent_to8: u64,
    }

    impl Closed {
        pub const LEN: usize = 16;
        pub fn to_bytes(&self) -> [u8; Self::LEN] {
            let mut b = [0u8; Self::LEN];
            b[..8].copy_from_slice(&self.rent.to_le_bytes());
            b[8..].copy_from_slice(&self.rent_to8.to_le_bytes());
            b
        }
        pub fn from_bytes(b: &[u8]) -> Option<Closed> {
            if b.len() != Self::LEN {
                return None;
            }
            Some(Closed {
                rent: rd_u64(b, 0)?,
                rent_to8: rd_u64(b, 8)?,
            })
        }
    }

    /// The first 8 bytes of a key as a little-endian tag.
    pub fn tag8(k: &[u8; 32]) -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&k[..8]);
        u64::from_le_bytes(b)
    }
}

// ------------------------------------------------------------ accounts

/// The account list of each Grant instruction, in the program's order, as
/// `(address, signer, writable)`: one table for the program's handlers, the
/// verifier (VR) and any client that builds the instructions (workstream
/// 4's run executor, a gateway, a wallet). Every address is public (the
/// Season PDA, the with-seed Citizen, Holding, Province and Grant
/// addresses of `AddrCtx`, a wallet); nothing here needs a key.
pub mod accounts {
    /// One account of an instruction: address, signer, writable.
    pub type Meta = ([u8; 32], bool, bool);

    /// IssueGrant: the player prologue (the issuer's wallet, the payer,
    /// the Season, the issuer's Citizen), then the facility, its Province,
    /// the grantee's Citizen, the station, the new Grant and the System
    /// program.
    pub const ISSUE_LEN: usize = 10;
    pub const ISSUE_FACILITY: usize = 4;
    pub const ISSUE_STATION: usize = 7;
    pub const ISSUE_GRANT: usize = 8;
    /// ReserveSwap, ExecuteSwap (the grantee's Citizen) and RevokeGrant
    /// (the issuer's): the player prologue, then the Grant, the facility,
    /// the station and their Province.
    pub const USE_LEN: usize = 8;
    pub const USE_GRANT: usize = 4;
    pub const USE_FACILITY: usize = 5;
    pub const USE_STATION: usize = 6;
    /// ReleaseSwap: the actor (the grantee's wallet or session, or anyone
    /// after the expiry), the Season, the grantee's Citizen, the Grant, the
    /// facility, the station and their Province.
    pub const RELEASE_LEN: usize = 7;
    pub const RELEASE_GRANT: usize = 3;
    pub const RELEASE_FACILITY: usize = 4;
    pub const RELEASE_STATION: usize = 5;
    /// CloseGrant: the actor, the Season, the Grant and the rent recipient
    /// the Grant names.
    pub const CLOSE_LEN: usize = 4;
    pub const CLOSE_GRANT: usize = 2;

    #[allow(clippy::too_many_arguments)]
    pub fn issue(
        actor: [u8; 32],
        payer: [u8; 32],
        season: [u8; 32],
        issuer_citizen: [u8; 32],
        facility: [u8; 32],
        province: [u8; 32],
        grantee_citizen: [u8; 32],
        station: [u8; 32],
        grant: [u8; 32],
    ) -> [Meta; ISSUE_LEN] {
        [
            (actor, true, false),
            (payer, true, true),
            (season, false, false),
            (issuer_citizen, false, true),
            (facility, false, false),
            (province, false, false),
            (grantee_citizen, false, false),
            (station, false, false),
            (grant, false, true),
            (crate::prologue::ids::SYSTEM_PROGRAM, false, false),
        ]
    }

    /// ReserveSwap and ExecuteSwap (`citizen`: the grantee's), RevokeGrant
    /// (`citizen`: the issuer's).
    #[allow(clippy::too_many_arguments)]
    pub fn use_grant(
        actor: [u8; 32],
        payer: [u8; 32],
        season: [u8; 32],
        citizen: [u8; 32],
        grant: [u8; 32],
        facility: [u8; 32],
        station: [u8; 32],
        province: [u8; 32],
    ) -> [Meta; USE_LEN] {
        [
            (actor, true, false),
            (payer, true, true),
            (season, false, false),
            (citizen, false, true),
            (grant, false, true),
            (facility, false, true),
            (station, false, true),
            (province, false, false),
        ]
    }

    pub fn release(
        actor: [u8; 32],
        season: [u8; 32],
        grantee_citizen: [u8; 32],
        grant: [u8; 32],
        facility: [u8; 32],
        station: [u8; 32],
        province: [u8; 32],
    ) -> [Meta; RELEASE_LEN] {
        [
            (actor, true, false),
            (season, false, false),
            (grantee_citizen, false, false),
            (grant, false, true),
            (facility, false, true),
            (station, false, true),
            (province, false, false),
        ]
    }

    pub fn close(
        actor: [u8; 32],
        season: [u8; 32],
        grant: [u8; 32],
        rent_to: [u8; 32],
    ) -> [Meta; CLOSE_LEN] {
        [
            (actor, true, false),
            (season, false, false),
            (grant, false, true),
            (rent_to, false, true),
        ]
    }
}

// ------------------------------------------------------------ reading a Grant

/// A Grant as its account bytes say, for readers off chain (a client's
/// state view; workstream 4's rights port, proposal). Pure: no clock and
/// no RPC; [`GrantView::status`] takes the time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrantView {
    pub season_id: u64,
    pub kind: u8,
    pub state: u8,
    pub p: i16,
    pub q: i16,
    pub facility_site: u8,
    pub station_site: u8,
    pub facility_gen: u8,
    pub station_gen: u8,
    pub nonce: u32,
    pub issuer_tag: u64,
    pub issuer_citizen: [u8; 32],
    pub grantee_citizen: [u8; 32],
    pub facility: [u8; 32],
    pub station: [u8; 32],
    pub expires_ts: i64,
    pub issued_ts: i64,
    pub max_swaps: u16,
    pub swaps: u16,
    pub max_units: u32,
    pub units_swapped: u32,
    pub open_units: u32,
    pub open_ts: i64,
    /// Escrowed ore, wood (station side) and arms (facility side), milli.
    pub open: [i64; 3],
    pub revoked_ts: i64,
    pub rent_to: [u8; 32],
}

/// What a Grant allows now (advisory: the program re-checks everything,
/// the holdings' stock and the Province's lock included, in the same
/// instruction that moves anything).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantStatus {
    /// ReserveSwap of `1..=units_left` units with `seq` may be accepted.
    Usable {
        seq: u16,
        swaps_left: u16,
        units_left: u32,
        expires_ts: i64,
    },
    /// A reservation of `units` is open: ExecuteSwap (seq `seq`) or
    /// ReleaseSwap is the next step.
    Reserved {
        seq: u16,
        units: u32,
        expires_ts: i64,
    },
    /// Past its expiry: nothing more can be reserved or executed; an open
    /// reservation (`open_units > 0`) can be released by anyone.
    Expired { open_units: u32 },
    /// Revoked by its issuer; `open_units > 0`: a side whose holding was
    /// gone stays escrowed until it can go back.
    Revoked { open_units: u32 },
    /// Its swaps or units are used up.
    Spent,
}

impl GrantView {
    /// `None` unless `d` is a version-1 Grant (size and magic).
    pub fn read(d: &[u8]) -> Option<GrantView> {
        use crate::bytes::{rd_arr, rd_i16, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8};
        use layout as G;
        if d.len() != G::SIZE || d[..8] != G::MAGIC || rd_u16(d, G::VERSION)? != G::VERSION_1 {
            return None;
        }
        Some(GrantView {
            season_id: rd_u64(d, G::SEASON_ID)?,
            kind: rd_u8(d, G::KIND)?,
            state: rd_u8(d, G::STATE)?,
            p: rd_i16(d, G::P)?,
            q: rd_i16(d, G::Q)?,
            facility_site: rd_u8(d, G::FACILITY_SITE)?,
            station_site: rd_u8(d, G::STATION_SITE)?,
            facility_gen: rd_u8(d, G::FACILITY_GEN)?,
            station_gen: rd_u8(d, G::STATION_GEN)?,
            nonce: rd_u32(d, G::NONCE)?,
            issuer_tag: rd_u64(d, G::ISSUER_TAG)?,
            issuer_citizen: rd_arr(d, G::ISSUER_CITIZEN)?,
            grantee_citizen: rd_arr(d, G::GRANTEE_CITIZEN)?,
            facility: rd_arr(d, G::FACILITY)?,
            station: rd_arr(d, G::STATION)?,
            expires_ts: rd_i64(d, G::EXPIRES_TS)?,
            issued_ts: rd_i64(d, G::ISSUED_TS)?,
            max_swaps: rd_u16(d, G::MAX_SWAPS)?,
            swaps: rd_u16(d, G::SWAPS)?,
            max_units: rd_u32(d, G::MAX_UNITS)?,
            units_swapped: rd_u32(d, G::UNITS_SWAPPED)?,
            open_units: rd_u32(d, G::OPEN_UNITS)?,
            open_ts: rd_i64(d, G::OPEN_TS)?,
            open: [
                rd_i64(d, G::OPEN_ORE)?,
                rd_i64(d, G::OPEN_WOOD)?,
                rd_i64(d, G::OPEN_ARMS)?,
            ],
            revoked_ts: rd_i64(d, G::REVOKED_TS)?,
            rent_to: rd_arr(d, G::RENT_TO)?,
        })
    }

    /// What the Grant allows at `now` (the program's order of checks:
    /// revoked, expired, an open reservation, the quota).
    pub fn status(&self, now: i64) -> GrantStatus {
        if self.state != STATE_ACTIVE {
            return GrantStatus::Revoked {
                open_units: self.open_units,
            };
        }
        if now >= self.expires_ts {
            return GrantStatus::Expired {
                open_units: self.open_units,
            };
        }
        if self.open_units != 0 {
            return GrantStatus::Reserved {
                seq: self.swaps,
                units: self.open_units,
                expires_ts: self.expires_ts,
            };
        }
        let units_left = self
            .max_units
            .saturating_sub(self.units_swapped)
            .min(MAX_UNITS_PER_SWAP);
        if self.swaps >= self.max_swaps || units_left == 0 {
            return GrantStatus::Spent;
        }
        GrantStatus::Usable {
            seq: self.swaps,
            swaps_left: self.max_swaps - self.swaps,
            units_left,
            expires_ts: self.expires_ts,
        }
    }
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

    /// The account builders follow their own index constants, and a Grant's
    /// status follows the program's order of checks.
    #[test]
    fn account_builders_and_the_status_reader() {
        let k = |n: u8| [n; 32];
        let a = accounts::issue(k(1), k(1), k(2), k(3), k(4), k(5), k(6), k(7), k(8));
        assert_eq!(a.len(), accounts::ISSUE_LEN);
        assert_eq!(a[accounts::ISSUE_FACILITY].0, k(4));
        assert_eq!(a[accounts::ISSUE_STATION].0, k(7));
        assert_eq!(a[accounts::ISSUE_GRANT], (k(8), false, true));
        let u = accounts::use_grant(k(1), k(1), k(2), k(3), k(9), k(4), k(7), k(5));
        assert_eq!(
            (
                u[accounts::USE_GRANT].0,
                u[accounts::USE_FACILITY].0,
                u[accounts::USE_STATION].0
            ),
            (k(9), k(4), k(7))
        );
        let r = accounts::release(k(1), k(2), k(3), k(9), k(4), k(7), k(5));
        assert_eq!(
            (
                r[accounts::RELEASE_GRANT].0,
                r[accounts::RELEASE_FACILITY].0,
                r[accounts::RELEASE_STATION].0
            ),
            (k(9), k(4), k(7))
        );
        assert_eq!(
            accounts::close(k(1), k(2), k(9), k(1))[accounts::CLOSE_GRANT].0,
            k(9)
        );
        // Only the actor (and the payer) sign; nothing else.
        let others = a[2..].iter().chain(&u[2..]).chain(&r[1..]);
        for m in others {
            assert!(!m.1, "{m:?}");
        }

        let mut d = [0u8; layout::SIZE];
        d[..8].copy_from_slice(&layout::MAGIC);
        d[layout::VERSION..layout::VERSION + 2].copy_from_slice(&layout::VERSION_1.to_le_bytes());
        d[layout::KIND] = KIND_STOCK_SWAP;
        d[layout::STATE] = STATE_ACTIVE;
        d[layout::EXPIRES_TS..layout::EXPIRES_TS + 8].copy_from_slice(&1_000i64.to_le_bytes());
        d[layout::MAX_SWAPS..layout::MAX_SWAPS + 2].copy_from_slice(&2u16.to_le_bytes());
        d[layout::MAX_UNITS..layout::MAX_UNITS + 4].copy_from_slice(&30u32.to_le_bytes());
        let v = GrantView::read(&d).unwrap();
        assert_eq!(
            v.status(10),
            GrantStatus::Usable {
                seq: 0,
                swaps_left: 2,
                units_left: 30,
                expires_ts: 1_000
            }
        );
        assert_eq!(v.status(1_000), GrantStatus::Expired { open_units: 0 });
        let mut o = v;
        o.open_units = 4;
        assert_eq!(
            o.status(10),
            GrantStatus::Reserved {
                seq: 0,
                units: 4,
                expires_ts: 1_000
            }
        );
        assert_eq!(o.status(2_000), GrantStatus::Expired { open_units: 4 });
        let mut s = v;
        s.swaps = 2;
        assert_eq!(s.status(10), GrantStatus::Spent);
        let mut s = v;
        s.units_swapped = 30;
        assert_eq!(s.status(10), GrantStatus::Spent);
        let mut x = o;
        x.state = STATE_REVOKED;
        assert_eq!(x.status(10), GrantStatus::Revoked { open_units: 4 });
        // Not a Grant: wrong size, magic or version.
        assert!(GrantView::read(&d[..layout::SIZE - 1]).is_none());
        let mut bad = d;
        bad[0] ^= 1;
        assert!(GrantView::read(&bad).is_none());
        let mut bad = d;
        bad[layout::VERSION] = 2;
        assert!(GrantView::read(&bad).is_none());
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
    fn record_payloads_match_the_log_table() {
        use crate::v2::log::AnyKind;
        let len = |k| AnyKind::Cq(k).payload_len();
        assert_eq!(len(record::ISSUED), record::Issued::LEN);
        assert_eq!(len(record::RESERVED), record::Swap::LEN);
        assert_eq!(len(record::EXECUTED), record::Swap::LEN);
        assert_eq!(len(record::RELEASED), record::Undo::LEN);
        assert_eq!(len(record::REVOKED), record::Undo::LEN);
        assert_eq!(len(record::CLOSED), record::Closed::LEN);
        for k in [
            record::ISSUED,
            record::RESERVED,
            record::EXECUTED,
            record::RELEASED,
            record::REVOKED,
            record::CLOSED,
        ] {
            assert_eq!(AnyKind::Cq(k).key_len(), 12);
            assert!(record::is_rights(k));
            // Provisional codes (workstream 4's allocation rev 3): above
            // the base table (up to 103), 8's 104 and 10's 105–113.
            assert!((114..=119).contains(&(k as u8)));
        }
        let s = record::Swap {
            grantee_tag: 7,
            p: -3,
            q: 9,
            facility_site: 1,
            station_site: 2,
            seq: 4,
            units: 5,
            ore: 10_000,
            wood: 5_000,
            arms: 5_000,
        };
        assert_eq!(record::Swap::from_bytes(&s.to_bytes()), Some(s));
        let u = record::Undo {
            by: record::by::ISSUER,
            p: 1,
            q: 2,
            facility_site: 0,
            station_site: 3,
            returned: [1, 2, 3],
            kept: [4, 5, 6],
        };
        assert_eq!(record::Undo::from_bytes(&u.to_bytes()), Some(u));
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
