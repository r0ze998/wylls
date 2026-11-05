//! The undecided rules, as switchable provisional choices (contract §4).
//! Fixed when the owner opens the pool, so a user who reserved under them
//! cannot be moved to worse ones later.

use borsh::{BorshDeserialize, BorshSerialize};

/// Who gets what a job keeps at the facility when the facility is lost
/// (captured or released): the hopper's rest and the unclaimed output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum LossPolicy {
    /// [provisional default] Everything at the facility goes to the
    /// captor, as a seized vault's goods do (design 20 §5). No captor (a
    /// release): back to the user.
    CaptorTakesAll,
    /// Everything stays the user's.
    UserKeepsAll,
    /// The output stays the user's; the unused materials go to the captor.
    UserKeepsOutput,
}

/// What the owner's absence (a dormant facility Holding) does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum DormancyPolicy {
    /// [provisional default] Nothing: the lent capacity was promised.
    Unaffected,
    /// No new reservation while the facility is dormant; booked and
    /// running jobs are kept.
    RefuseNewWhenDormant,
}

/// What a revoked grant does to its jobs that have not started.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum RevokePolicy {
    /// [provisional default] They run as booked.
    HonorBooked,
    /// They are cancelled at the revocation (full refund). A running job
    /// is never stopped by the owner.
    CancelBooked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Policies {
    pub loss: LossPolicy,
    pub dormancy: DormancyPolicy,
    pub revoke: RevokePolicy,
}

impl Policies {
    pub const PROVISIONAL: Policies = Policies {
        loss: LossPolicy::CaptorTakesAll,
        dormancy: DormancyPolicy::Unaffected,
        revoke: RevokePolicy::HonorBooked,
    };
}

impl Default for Policies {
    fn default() -> Self {
        Policies::PROVISIONAL
    }
}
