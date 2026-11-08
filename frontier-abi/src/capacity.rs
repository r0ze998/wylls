//! **Preview, opt-in** (`--features capacity-preview`): workstream 09's
//! instructions (lending a workshop's processing capacity), their data,
//! their account lists and their accounts' addresses.
//!
//! **Numbers.** The tags `0xF0..=0xFD` and the program errors `110..=139`
//! are workstream 4's provisional allocation (`ABI-ALLOCATION-20261106.ja.md`
//! rev 3–6: tags 0xF0–0xFD, errors 110–149, AccountKind 25 CapacityPool and
//! 26 CapacityJob, seeds `cp` and `cj`). The magic values (`PSF1CPOL`,
//! `PSF1CJOB`) and [`CAPACITY_PREVIEW_VERSION_BIT`] are workstream 09's
//! proposals, not allocations. **No record kind is allocated** (workstream
//! 09 has 20 kinds of record, workstream 4's band 120–129 holds 10): a
//! capacity build logs no PS2 record for these instructions, and the
//! verifier cannot judge them (they are unverifiable, as custody was before
//! V26).
//!
//! A default build of the program never dispatches these bytes
//! (`v2::ix::tag_of` refuses them); only a program built with
//! `capacity-preview` routes them, and it carries the version bit so its
//! Seasons never mix with production ones.
//!
//! | tag | instruction | class | data after the tag |
//! |---|---|---|---|
//! | 0xF0 | OpenCapacityPool | P (owner) | `policies [u8;3]` |
//! | 0xF1 | LendCapacity | P (owner) | `units u32, seq u32` |
//! | 0xF2 | ReclaimCapacity | P (owner) | `units u32, seq u32` |
//! | 0xF3 | GrantCapacity | P (owner) | `grant u32, user [u8;32], recipe u8, max_units u32, max_output i64, from i64, until i64` |
//! | 0xF4 | RevokeCapacity | P (owner) | `grant u32` |
//! | 0xF5 | ReserveCapacity | P (user) | `grant u32, job u32, units u32, start i64, end i64, max_output i64` |
//! | 0xF6 | DepositToJob | P (user) | `grant u32, job u32, deposit u64, resource u8, amount i64, source u8, slot u8, order u32` |
//! | 0xF7 | SettleJob | N (anyone) | `grant u32, job u32` |
//! | 0xF8 | CancelJob | P (user) | `grant u32, job u32` |
//! | 0xF9 | ClaimJob | P (user) | `grant u32, job u32` |
//! | 0xFA | RecordFacilityLoss | N (anyone) | — |
//! | 0xFB | RetireJob | N (anyone) | `grant u32, job u32` |
//! | 0xFC | RetireGrant | N (anyone) | `grant u32` |
//! | 0xFD | RetirePool | N (anyone) | — |
//!
//! DepositToJob's `source`: [`SOURCE_VAULT`] (the user's own vault in the
//! facility's province; `slot` and `order` 0) or [`SOURCE_LOT`] (another
//! owner's lot in a vault of that province, under its use order `(slot,
//! order)` for the user with purpose [`PURPOSE_WORKSHOP_ARMS`];
//! workstream 10's custody, `custody-preview` builds only). ClaimJob of a
//! job fed from a lot lists that lot and its vault after the user's vault:
//! the ore left unused goes back into the lot (the owner's decision of
//! 2026-11-06).
//!
//! `user` in GrantCapacity is the user's **Citizen** key (the owner, a user
//! and a captor are Citizens). Amounts are milli-units. Every encoding is
//! fixed width, little-endian, exact length.

use crate::addr::{AddrCtx, Seed};
use crate::bytes::{Cursor, Writer};
use crate::error::FrontierError;
use crate::layout::AccountKind as K;
use crate::prologue::{Acc, Group, Spec, Wr};
use crate::v2::layout::AccountKind as K2;

/// The bit a capacity build sets in its `PROGRAM_VERSION` (proposal;
/// disjoint from the NFT build's `0x8000` and the wide build's `0x4000`).
pub const CAPACITY_PREVIEW_VERSION_BIT: u16 = 0x2000;

pub const TAG_FIRST: u8 = 0xF0;
pub const TAG_LAST: u8 = 0xFD;

/// Whether `t` is one of workstream 09's tags.
pub const fn is_capacity_tag(t: u8) -> bool {
    t >= TAG_FIRST && t <= TAG_LAST
}

/// The fourteen instructions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum CapIx {
    OpenCapacityPool = 0xF0,
    LendCapacity = 0xF1,
    ReclaimCapacity = 0xF2,
    GrantCapacity = 0xF3,
    RevokeCapacity = 0xF4,
    ReserveCapacity = 0xF5,
    DepositToJob = 0xF6,
    SettleJob = 0xF7,
    CancelJob = 0xF8,
    ClaimJob = 0xF9,
    RecordFacilityLoss = 0xFA,
    RetireJob = 0xFB,
    RetireGrant = 0xFC,
    RetirePool = 0xFD,
}

impl CapIx {
    pub const ALL: [CapIx; 14] = [
        CapIx::OpenCapacityPool,
        CapIx::LendCapacity,
        CapIx::ReclaimCapacity,
        CapIx::GrantCapacity,
        CapIx::RevokeCapacity,
        CapIx::ReserveCapacity,
        CapIx::DepositToJob,
        CapIx::SettleJob,
        CapIx::CancelJob,
        CapIx::ClaimJob,
        CapIx::RecordFacilityLoss,
        CapIx::RetireJob,
        CapIx::RetireGrant,
        CapIx::RetirePool,
    ];

    pub const fn tag(self) -> u8 {
        self as u8
    }

    pub const fn from_tag(t: u8) -> Option<CapIx> {
        Some(match t {
            0xF0 => CapIx::OpenCapacityPool,
            0xF1 => CapIx::LendCapacity,
            0xF2 => CapIx::ReclaimCapacity,
            0xF3 => CapIx::GrantCapacity,
            0xF4 => CapIx::RevokeCapacity,
            0xF5 => CapIx::ReserveCapacity,
            0xF6 => CapIx::DepositToJob,
            0xF7 => CapIx::SettleJob,
            0xF8 => CapIx::CancelJob,
            0xF9 => CapIx::ClaimJob,
            0xFA => CapIx::RecordFacilityLoss,
            0xFB => CapIx::RetireJob,
            0xFC => CapIx::RetireGrant,
            0xFD => CapIx::RetirePool,
            _ => return None,
        })
    }

    pub const fn name(self) -> &'static str {
        match self {
            CapIx::OpenCapacityPool => "OpenCapacityPool",
            CapIx::LendCapacity => "LendCapacity",
            CapIx::ReclaimCapacity => "ReclaimCapacity",
            CapIx::GrantCapacity => "GrantCapacity",
            CapIx::RevokeCapacity => "RevokeCapacity",
            CapIx::ReserveCapacity => "ReserveCapacity",
            CapIx::DepositToJob => "DepositToJob",
            CapIx::SettleJob => "SettleJob",
            CapIx::CancelJob => "CancelJob",
            CapIx::ClaimJob => "ClaimJob",
            CapIx::RecordFacilityLoss => "RecordFacilityLoss",
            CapIx::RetireJob => "RetireJob",
            CapIx::RetireGrant => "RetireGrant",
            CapIx::RetirePool => "RetirePool",
        }
    }

    /// P: a player's (the owner's or the user's); N: anyone's.
    pub const fn class(self) -> crate::tags::Class {
        match self {
            CapIx::SettleJob
            | CapIx::RecordFacilityLoss
            | CapIx::RetireJob
            | CapIx::RetireGrant
            | CapIx::RetirePool => crate::tags::Class::N,
            _ => crate::tags::Class::P,
        }
    }

    /// None refuses CPI (an external program may lend or reserve).
    pub const fn top_level_only(self) -> bool {
        false
    }
}

/// The instruction of `data` (`BadData` for any other tag).
pub fn tag_of(data: &[u8]) -> Result<CapIx, FrontierError> {
    data.first()
        .and_then(|t| CapIx::from_tag(*t))
        .ok_or(FrontierError::BadData)
}

/// DepositToJob from the user's own vault.
pub const SOURCE_VAULT: u8 = 0;
/// DepositToJob from another owner's lot under a use order.
pub const SOURCE_LOT: u8 = 1;
/// The purpose a use order names for the workshop (workstream 4's rev 4:
/// workstream 09's and 10's shared value, provisional).
pub const PURPOSE_WORKSHOP_ARMS: u16 = 0x0901;

// ------------------------------------------------------------ errors

/// The program error of the kernel's refusal `code` (1–30): `109 + code`.
pub const ERROR_BASE: u32 = 109;

pub const fn program_error(code: u16) -> u32 {
    ERROR_BASE + code as u32
}

// ------------------------------------------------------------ addresses

/// The CapacityPool seed tag (workstream 4's provisional `cp`).
pub const POOL: [u8; 2] = *b"cp";
/// The CapacityJob seed tag (`cj`).
pub const JOB: [u8; 2] = *b"cj";
pub const POOL_RAW_LEN: usize = 6;
pub const JOB_RAW_LEN: usize = 14;

fn pool_raw(p: i16, q: i16, site: u8, gen: u8) -> [u8; POOL_RAW_LEN] {
    let mut r = [0u8; POOL_RAW_LEN];
    r[..2].copy_from_slice(&p.to_le_bytes());
    r[2..4].copy_from_slice(&q.to_le_bytes());
    r[4] = site;
    r[5] = gen;
    r
}

/// `cp‖hex(le16 p ‖ le16 q ‖ site ‖ gen)`.
pub fn pool_seed(p: i16, q: i16, site: u8, gen: u8) -> Seed {
    Seed::new(POOL, &pool_raw(p, q, site, gen))
}

/// The pool of the facility at Holding `(p, q, site)`, generation `gen`.
pub fn pool(ctx: &AddrCtx, p: i16, q: i16, site: u8, gen: u8) -> [u8; 32] {
    ctx.of(&pool_seed(p, q, site, gen))
}

/// `cj‖hex(pool raw ‖ le32 grant ‖ le32 job)`.
pub fn job_seed(p: i16, q: i16, site: u8, gen: u8, grant: u32, job: u32) -> Seed {
    let mut r = [0u8; JOB_RAW_LEN];
    r[..POOL_RAW_LEN].copy_from_slice(&pool_raw(p, q, site, gen));
    r[6..10].copy_from_slice(&grant.to_le_bytes());
    r[10..14].copy_from_slice(&job.to_le_bytes());
    Seed::new(JOB, &r)
}

/// The account of job `(grant, job)` in that pool.
pub fn job(ctx: &AddrCtx, p: i16, q: i16, site: u8, gen: u8, grant: u32, job: u32) -> [u8; 32] {
    ctx.of(&job_seed(p, q, site, gen, grant, job))
}

/// Bytes after the rules' record in each account: the rent payer (32), to
/// whom the account's rent goes back when it closes.
pub const RENT_TO_LEN: usize = 32;

// ------------------------------------------------------------ data

/// The data of an instruction, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapData {
    OpenCapacityPool {
        policies: [u8; 3],
    },
    LendCapacity {
        units: u32,
        seq: u32,
    },
    ReclaimCapacity {
        units: u32,
        seq: u32,
    },
    GrantCapacity {
        grant: u32,
        user: [u8; 32],
        recipe: u8,
        max_units: u32,
        max_output: i64,
        from: i64,
        until: i64,
    },
    RevokeCapacity {
        grant: u32,
    },
    ReserveCapacity {
        grant: u32,
        job: u32,
        units: u32,
        start: i64,
        end: i64,
        max_output: i64,
    },
    DepositToJob {
        grant: u32,
        job: u32,
        deposit: u64,
        resource: u8,
        amount: i64,
        source: u8,
        slot: u8,
        order: u32,
    },
    SettleJob {
        grant: u32,
        job: u32,
    },
    CancelJob {
        grant: u32,
        job: u32,
    },
    ClaimJob {
        grant: u32,
        job: u32,
    },
    RecordFacilityLoss,
    RetireJob {
        grant: u32,
        job: u32,
    },
    RetireGrant {
        grant: u32,
    },
    RetirePool,
}

impl CapData {
    pub const fn ix(&self) -> CapIx {
        match self {
            CapData::OpenCapacityPool { .. } => CapIx::OpenCapacityPool,
            CapData::LendCapacity { .. } => CapIx::LendCapacity,
            CapData::ReclaimCapacity { .. } => CapIx::ReclaimCapacity,
            CapData::GrantCapacity { .. } => CapIx::GrantCapacity,
            CapData::RevokeCapacity { .. } => CapIx::RevokeCapacity,
            CapData::ReserveCapacity { .. } => CapIx::ReserveCapacity,
            CapData::DepositToJob { .. } => CapIx::DepositToJob,
            CapData::SettleJob { .. } => CapIx::SettleJob,
            CapData::CancelJob { .. } => CapIx::CancelJob,
            CapData::ClaimJob { .. } => CapIx::ClaimJob,
            CapData::RecordFacilityLoss => CapIx::RecordFacilityLoss,
            CapData::RetireJob { .. } => CapIx::RetireJob,
            CapData::RetireGrant { .. } => CapIx::RetireGrant,
            CapData::RetirePool => CapIx::RetirePool,
        }
    }

    /// The exact length of an instruction's data, tag included.
    pub const fn len_of(ix: CapIx) -> usize {
        1 + match ix {
            CapIx::OpenCapacityPool => 3,
            CapIx::LendCapacity | CapIx::ReclaimCapacity => 8,
            CapIx::GrantCapacity => 4 + 32 + 1 + 4 + 8 + 8 + 8,
            CapIx::RevokeCapacity | CapIx::RetireGrant => 4,
            CapIx::ReserveCapacity => 4 + 4 + 4 + 8 + 8 + 8,
            CapIx::DepositToJob => 4 + 4 + 8 + 1 + 8 + 1 + 1 + 4,
            CapIx::SettleJob | CapIx::CancelJob | CapIx::ClaimJob | CapIx::RetireJob => 8,
            CapIx::RecordFacilityLoss | CapIx::RetirePool => 0,
        }
    }

    pub fn decode(d: &[u8]) -> Result<CapData, FrontierError> {
        let ix = tag_of(d)?;
        if d.len() != Self::len_of(ix) {
            return Err(FrontierError::BadData);
        }
        let bad = FrontierError::BadData;
        let mut c = Cursor::new(&d[1..]);
        let gj = |c: &mut Cursor| -> Result<(u32, u32), FrontierError> {
            Ok((c.u32().ok_or(bad)?, c.u32().ok_or(bad)?))
        };
        Ok(match ix {
            CapIx::OpenCapacityPool => CapData::OpenCapacityPool {
                policies: [c.u8().ok_or(bad)?, c.u8().ok_or(bad)?, c.u8().ok_or(bad)?],
            },
            CapIx::LendCapacity => CapData::LendCapacity {
                units: c.u32().ok_or(bad)?,
                seq: c.u32().ok_or(bad)?,
            },
            CapIx::ReclaimCapacity => CapData::ReclaimCapacity {
                units: c.u32().ok_or(bad)?,
                seq: c.u32().ok_or(bad)?,
            },
            CapIx::GrantCapacity => CapData::GrantCapacity {
                grant: c.u32().ok_or(bad)?,
                user: c.arr::<32>().ok_or(bad)?,
                recipe: c.u8().ok_or(bad)?,
                max_units: c.u32().ok_or(bad)?,
                max_output: c.i64().ok_or(bad)?,
                from: c.i64().ok_or(bad)?,
                until: c.i64().ok_or(bad)?,
            },
            CapIx::RevokeCapacity => CapData::RevokeCapacity {
                grant: c.u32().ok_or(bad)?,
            },
            CapIx::ReserveCapacity => {
                let (grant, job) = gj(&mut c)?;
                CapData::ReserveCapacity {
                    grant,
                    job,
                    units: c.u32().ok_or(bad)?,
                    start: c.i64().ok_or(bad)?,
                    end: c.i64().ok_or(bad)?,
                    max_output: c.i64().ok_or(bad)?,
                }
            }
            CapIx::DepositToJob => {
                let (grant, job) = gj(&mut c)?;
                let (deposit, resource, amount) =
                    (c.u64().ok_or(bad)?, c.u8().ok_or(bad)?, c.i64().ok_or(bad)?);
                let (source, slot, order) =
                    (c.u8().ok_or(bad)?, c.u8().ok_or(bad)?, c.u32().ok_or(bad)?);
                if source > SOURCE_LOT || (source == SOURCE_VAULT && (slot, order) != (0, 0)) {
                    return Err(bad);
                }
                CapData::DepositToJob {
                    grant,
                    job,
                    deposit,
                    resource,
                    amount,
                    source,
                    slot,
                    order,
                }
            }
            CapIx::SettleJob => {
                let (grant, job) = gj(&mut c)?;
                CapData::SettleJob { grant, job }
            }
            CapIx::CancelJob => {
                let (grant, job) = gj(&mut c)?;
                CapData::CancelJob { grant, job }
            }
            CapIx::ClaimJob => {
                let (grant, job) = gj(&mut c)?;
                CapData::ClaimJob { grant, job }
            }
            CapIx::RecordFacilityLoss => CapData::RecordFacilityLoss,
            CapIx::RetireJob => {
                let (grant, job) = gj(&mut c)?;
                CapData::RetireJob { grant, job }
            }
            CapIx::RetireGrant => CapData::RetireGrant {
                grant: c.u32().ok_or(bad)?,
            },
            CapIx::RetirePool => CapData::RetirePool,
        })
    }

    /// The instruction's bytes (tag first).
    pub fn encode(&self) -> alloc::vec::Vec<u8> {
        let ix = self.ix();
        let mut b = alloc::vec![0u8; Self::len_of(ix)];
        let mut w = Writer::new(&mut b);
        w.u8(ix.tag());
        match *self {
            CapData::OpenCapacityPool { policies } => {
                w.u8(policies[0]).u8(policies[1]).u8(policies[2]);
            }
            CapData::LendCapacity { units, seq } | CapData::ReclaimCapacity { units, seq } => {
                w.u32(units).u32(seq);
            }
            CapData::GrantCapacity {
                grant,
                user,
                recipe,
                max_units,
                max_output,
                from,
                until,
            } => {
                w.u32(grant)
                    .bytes(&user)
                    .u8(recipe)
                    .u32(max_units)
                    .i64(max_output)
                    .i64(from)
                    .i64(until);
            }
            CapData::RevokeCapacity { grant } | CapData::RetireGrant { grant } => {
                w.u32(grant);
            }
            CapData::ReserveCapacity {
                grant,
                job,
                units,
                start,
                end,
                max_output,
            } => {
                w.u32(grant)
                    .u32(job)
                    .u32(units)
                    .i64(start)
                    .i64(end)
                    .i64(max_output);
            }
            CapData::DepositToJob {
                grant,
                job,
                deposit,
                resource,
                amount,
                source,
                slot,
                order,
            } => {
                w.u32(grant)
                    .u32(job)
                    .u64(deposit)
                    .u8(resource)
                    .i64(amount)
                    .u8(source)
                    .u8(slot)
                    .u32(order);
            }
            CapData::SettleJob { grant, job }
            | CapData::CancelJob { grant, job }
            | CapData::ClaimJob { grant, job }
            | CapData::RetireJob { grant, job } => {
                w.u32(grant).u32(job);
            }
            CapData::RecordFacilityLoss | CapData::RetirePool => {}
        }
        b
    }
}

// ------------------------------------------------------------ accounts

const fn s(name: &'static str, acc: Acc, signer: bool, wr: Wr) -> Spec {
    Spec {
        name,
        acc,
        signer,
        wr,
    }
}

const fn one(specs: &'static [Spec]) -> Group {
    Group {
        specs,
        min: 1,
        max: 1,
    }
}

const fn upto(specs: &'static [Spec], max: u8) -> Group {
    Group { specs, min: 0, max }
}

/// A capacity account (no `AccountKind` is allocated in the ABI yet): the
/// flag check treats it as any account; the handler authenticates owner,
/// address, magic and the record itself.
const CAP: Acc = Acc::Any;
/// A player's account the handler reads by its v2 layout (Holding, Vault):
/// authenticated by the handler (owner, magic, season, address).
const V2: Acc = Acc::Any;

const ACTOR: Spec = s("actor", Acc::Wallet, true, Wr::R);
const PAYER: Spec = s("payer", Acc::Wallet, true, Wr::W);
const SEASON: Spec = s("season", Acc::Kind(K::Season), false, Wr::R);
const CITIZEN: Spec = s("citizen", Acc::Kind(K::Citizen), false, Wr::W);
const FEE_PAYER: Spec = s("fee_payer", Acc::Wallet, true, Wr::W);
const SYSTEM: Spec = s("system", Acc::System, false, Wr::R);

/// Most jobs RevokeCapacity and RecordFacilityLoss write (the pool's).
pub const MAX_JOB_ACCOUNTS: u8 = 16;

const POOL_W: Spec = s("pool", CAP, false, Wr::W);
const JOB_W: Spec = s("job", CAP, false, Wr::W);
const HOLDING_R: Spec = s("holding", V2, false, Wr::R);
const HOLDING_W: Spec = s("holding", V2, false, Wr::W);
const VAULT_W: Spec = s("vault", V2, false, Wr::W);
const RENT_TO: Spec = s("rent_to", Acc::Wallet, false, Wr::W);

/// `[holding r] [pool w] [system]` after the player prologue.
pub const OPEN_POOL: &[Group] = &[one(&[
    ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W, SYSTEM,
])];
/// `[holding w] [pool w]`: the Holding's own production changes.
pub const LEND: &[Group] = &[one(&[ACTOR, PAYER, SEASON, CITIZEN, HOLDING_W, POOL_W])];
/// `[holding r] [pool w]`.
pub const OWNER_POOL: &[Group] = &[one(&[ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W])];
/// `[holding r] [pool w] [job w ×0..16]` (the grant's booked jobs under
/// CancelBooked).
pub const REVOKE: &[Group] = &[
    one(&[ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W]),
    upto(&[JOB_W], MAX_JOB_ACCOUNTS),
];
/// `[holding r] [pool w] [job w] [system]`.
pub const RESERVE: &[Group] = &[one(&[
    ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W, JOB_W, SYSTEM,
])];
/// `[holding r] [pool w] [job w] [vault w]`: for DepositToJob the vault
/// the goods come from (the user's own, or the lot's); for ClaimJob the
/// user's own, where they go.
pub const USER_VAULT: &[Group] = &[one(&[
    ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W, JOB_W, VAULT_W,
])];
/// DepositToJob: then `[lot w]` from a lot.
pub const DEPOSIT: &[Group] = &[
    one(&[
        ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W, JOB_W, VAULT_W,
    ]),
    upto(&[s("lot", Acc::KindV2(K2::Lot), false, Wr::W)], 1),
];
/// ClaimJob: then `[lot_vault r] [lot w]` for a job fed from a lot.
pub const CLAIM: &[Group] = &[
    one(&[
        ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W, JOB_W, VAULT_W,
    ]),
    upto(
        &[
            s("lot_vault", Acc::KindV2(K2::Vault), false, Wr::R),
            s("lot", Acc::KindV2(K2::Lot), false, Wr::W),
        ],
        1,
    ),
];
/// `[holding r] [pool w] [job w]`.
pub const USER_JOB: &[Group] = &[one(&[
    ACTOR, PAYER, SEASON, CITIZEN, HOLDING_R, POOL_W, JOB_W,
])];
/// `[fee_payer s,w] [season] [holding r] [pool w] [job w]`.
pub const SETTLE: &[Group] = &[one(&[FEE_PAYER, SEASON, HOLDING_R, POOL_W, JOB_W])];
/// `[fee_payer s,w] [season] [holding w] [pool w] [job w ×0..16]`: every
/// job of the pool; what a captor takes goes into the Holding's stores.
pub const LOSS: &[Group] = &[
    one(&[FEE_PAYER, SEASON, HOLDING_W, POOL_W]),
    upto(&[JOB_W], MAX_JOB_ACCOUNTS),
];
/// `[fee_payer s,w] [season] [pool w] [job w] [rent_to w]`.
pub const RETIRE_JOB: &[Group] = &[one(&[FEE_PAYER, SEASON, POOL_W, JOB_W, RENT_TO])];
/// `[fee_payer s,w] [season] [pool w]`.
pub const RETIRE_GRANT: &[Group] = &[one(&[FEE_PAYER, SEASON, POOL_W])];
/// `[fee_payer s,w] [season] [pool w] [rent_to w]`.
pub const RETIRE_POOL: &[Group] = &[one(&[FEE_PAYER, SEASON, POOL_W, RENT_TO])];

/// The account list of an instruction. The player prologue (`[actor s]
/// [payer s,w] [season] [citizen w]`) for the owner's and the user's; the
/// keeper prologue (`[fee_payer s,w] [season]`) for anyone's.
pub const fn accounts_of(ix: CapIx) -> &'static [Group] {
    match ix {
        CapIx::OpenCapacityPool => OPEN_POOL,
        CapIx::LendCapacity | CapIx::ReclaimCapacity => LEND,
        CapIx::GrantCapacity => OWNER_POOL,
        CapIx::RevokeCapacity => REVOKE,
        CapIx::ReserveCapacity => RESERVE,
        CapIx::DepositToJob => DEPOSIT,
        CapIx::ClaimJob => CLAIM,
        CapIx::CancelJob => USER_JOB,
        CapIx::SettleJob => SETTLE,
        CapIx::RecordFacilityLoss => LOSS,
        CapIx::RetireJob => RETIRE_JOB,
        CapIx::RetireGrant => RETIRE_GRANT,
        CapIx::RetirePool => RETIRE_POOL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    /// The band is workstream 4's for workstream 09, free of every v2 tag,
    /// reserved tag and other workstream's band; the version bit is disjoint
    /// from the NFT and wide builds' and from every production value.
    #[test]
    fn the_band_is_09s_and_the_version_bit_is_disjoint() {
        for t in TAG_FIRST..=TAG_LAST {
            assert!(is_capacity_tag(t));
            assert!(crate::v2::Ix::from_tag(t).is_none(), "{t:#x} is a v2 tag");
            assert!(
                crate::tags::Ix::from_tag(t).is_none(),
                "{t:#x} is an M1 tag"
            );
            assert!(!crate::v2::tags::is_reserved(t), "{t:#x} is reserved");
            assert!(!crate::resident_wire::is_resident_tag(t), "{t:#x} is 20's");
            assert!(CapIx::from_tag(t).is_some());
            assert_eq!(crate::v2::ix::tag_of(&[t]).ok(), None);
        }
        for t in [0xEFu8, 0xFE, 0xFF, 0xD6, 0xC2] {
            assert!(!is_capacity_tag(t));
            assert_eq!(tag_of(&[t]), Err(FrontierError::BadData));
        }
        for (i, a) in CapIx::ALL.iter().enumerate() {
            assert_eq!(CapIx::from_tag(a.tag()), Some(*a));
            assert_eq!(a.tag(), TAG_FIRST + i as u8, "{}", a.name());
        }
        use crate::v2::presets::{PROGRAM_VERSION_S1, PROGRAM_VERSION_V2};
        for v in [PROGRAM_VERSION_V2, PROGRAM_VERSION_S1, 5u16, 0x8004, 0x4004] {
            assert_eq!(v & CAPACITY_PREVIEW_VERSION_BIT, 0, "{v:#x}");
        }
        assert_eq!(CAPACITY_PREVIEW_VERSION_BIT & (0x8000 | 0x4000), 0);
    }

    #[test]
    fn a_vault_source_names_no_order() {
        let mut b = CapData::DepositToJob {
            grant: 1,
            job: 1,
            deposit: 1,
            resource: 3,
            amount: 1,
            source: SOURCE_VAULT,
            slot: 0,
            order: 0,
        }
        .encode();
        assert!(CapData::decode(&b).is_ok());
        let n = b.len();
        b[n - 1] = 1;
        assert_eq!(CapData::decode(&b), Err(FrontierError::BadData));
        b[n - 1] = 0;
        b[n - 6] = 2;
        assert_eq!(
            CapData::decode(&b),
            Err(FrontierError::BadData),
            "no source 2"
        );
    }

    #[test]
    fn errors_are_4s_band() {
        assert_eq!(program_error(1), 110);
        assert_eq!(program_error(30), 139);
    }

    #[test]
    fn seeds_are_new_and_fit() {
        let s = pool_seed(-1, 2, 3, 255);
        assert_eq!(&s.as_bytes()[..2], b"cp");
        assert_eq!(s.as_bytes(), b"cpffff020003ff");
        assert!(job_seed(i16::MIN, i16::MAX, 255, 255, u32::MAX, u32::MAX).len() <= 32);
        for t in [POOL, JOB] {
            for k in crate::layout::AccountKind::ALL {
                assert_ne!(crate::addr::tag_of(k), Some(t), "{}", k.name());
            }
            for k in crate::v2::layout::AccountKind::ALL {
                assert_ne!(crate::v2::addr::tag_of(k), Some(t), "{}", k.name());
            }
        }
        let ctx = AddrCtx {
            season: [1; 32],
            program: [2; 32],
        };
        assert_ne!(pool(&ctx, 0, 0, 0, 1), pool(&ctx, 0, 0, 0, 2));
        assert_ne!(job(&ctx, 0, 0, 0, 1, 1, 1), job(&ctx, 0, 0, 0, 1, 1, 2));
        assert_ne!(job(&ctx, 0, 0, 0, 1, 1, 2), job(&ctx, 0, 0, 0, 1, 2, 1));
    }

    #[test]
    fn encodings_are_exact_and_round_trip() {
        let all = [
            CapData::OpenCapacityPool {
                policies: [0, 1, 1],
            },
            CapData::LendCapacity { units: 2, seq: 0 },
            CapData::ReclaimCapacity { units: 1, seq: 1 },
            CapData::GrantCapacity {
                grant: 1,
                user: [7; 32],
                recipe: 1,
                max_units: 2,
                max_output: 100_000,
                from: -5,
                until: i64::MAX,
            },
            CapData::RevokeCapacity { grant: 9 },
            CapData::ReserveCapacity {
                grant: 1,
                job: 2,
                units: 2,
                start: 10,
                end: 20,
                max_output: 30,
            },
            CapData::DepositToJob {
                grant: 1,
                job: 2,
                deposit: u64::MAX,
                resource: 3,
                amount: 40_000,
                source: SOURCE_LOT,
                slot: 1,
                order: 9,
            },
            CapData::SettleJob { grant: 1, job: 2 },
            CapData::CancelJob { grant: 1, job: 2 },
            CapData::ClaimJob { grant: 1, job: 2 },
            CapData::RecordFacilityLoss,
            CapData::RetireJob { grant: 1, job: 2 },
            CapData::RetireGrant { grant: 1 },
            CapData::RetirePool,
        ];
        let tags: Vec<u8> = all.iter().map(|d| d.ix().tag()).collect();
        let want: Vec<u8> = CapIx::ALL.iter().map(|i| i.tag()).collect();
        assert_eq!(tags, want, "one of each");
        for d in all {
            let b = d.encode();
            assert_eq!(b.len(), CapData::len_of(d.ix()));
            assert_eq!(CapData::decode(&b), Ok(d));
            assert_eq!(
                CapData::decode(&b[..b.len() - 1]),
                Err(FrontierError::BadData)
            );
            let mut long = b.clone();
            long.push(0);
            assert_eq!(CapData::decode(&long), Err(FrontierError::BadData));
        }
    }

    #[test]
    fn account_lists_resolve() {
        use crate::prologue::bounds_in;
        for ix in CapIx::ALL {
            let (lo, hi) = bounds_in(accounts_of(ix));
            assert!(
                lo >= 3 && hi <= 4 + 4 + MAX_JOB_ACCOUNTS as usize,
                "{}",
                ix.name()
            );
        }
    }
}
