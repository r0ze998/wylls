//! Events (contract §3). Every applied operation logs at least one.

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::frontier::holding::Resource;

use crate::model::{Actor, FacilityId, GrantId, JobId, Place};

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Event {
    PoolOpened {
        facility: FacilityId,
        owner: Actor,
    },
    Lent {
        facility: FacilityId,
        units: u32,
        lent: u32,
        at: i64,
    },
    Reclaimed {
        facility: FacilityId,
        units: u32,
        lent: u32,
        at: i64,
    },
    Granted {
        grant: GrantId,
        user: Actor,
    },
    Revoked {
        grant: GrantId,
        at: i64,
        cancelled: u32,
    },
    Reserved {
        job: JobId,
        units: u32,
        start: i64,
        end: i64,
        max_output: i64,
    },
    Deposited {
        job: JobId,
        deposit: u64,
        resource: Resource,
        amount: i64,
    },
    Started {
        job: JobId,
        at: i64,
    },
    /// Output made since the last settle and the inputs it used (milli).
    Settled {
        job: JobId,
        out: i64,
        used: [i64; 2],
        total: i64,
    },
    Completed {
        job: JobId,
        at: i64,
        out: i64,
    },
    Cancelled {
        job: JobId,
        at: i64,
        out: i64,
    },
    Lost {
        job: JobId,
        at: i64,
        out: i64,
    },
    Claimed {
        job: JobId,
        output: i64,
        refund: [i64; 2],
        to: Place,
    },
    /// Goods a loss moved from a job's places to `to` (owner `owner`).
    Forfeited {
        job: JobId,
        output: i64,
        refund: [i64; 2],
        to: Place,
        owner: Actor,
    },
    FacilityLost {
        facility: FacilityId,
        at: i64,
        captor: Option<Actor>,
    },
}
