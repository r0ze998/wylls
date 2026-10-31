//! The keeper's next step for one target in a **continuing world**: when to
//! commit, when to bring the target home and when to send it back. Pure;
//! it reads the reconciler's [`Decision`] and the delegation record.
//!
//! Nothing here looks at a period, a war-period boundary or an end of the
//! world: a delegation session ends only because
//!
//! * its sponsored commit budget is nearly spent (the delegation program
//!   refuses commit 11 of a session without a delegated fee payer; the last
//!   slot is kept for the commit-and-undelegate that ends it), or
//! * the world's trusted validator changed (the old one is `retiring`), or
//! * an operator asked for maintenance (`drain`).
//!
//! A session that ends this way is followed by a new delegation, so the
//! target lives on across any number of sessions with one `(seq, head)`
//! chain. Writes stop only while a target is between sessions (a few base
//! slots), which the planner reports as such.

use crate::guard::{Decision, Hold};
use crate::sim::{Key, SPONSORED_COMMITS};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// The validator new sessions are delegated to.
    pub preferred: Key,
    /// Commits a session may use before it is brought home (≤ cap − 1).
    pub commits_per_session: u32,
    /// Bring the target home and keep it on the base (maintenance).
    pub drain: bool,
}

impl Plan {
    pub fn new(preferred: Key) -> Plan {
        Plan {
            preferred,
            commits_per_session: SPONSORED_COMMITS - 1,
            drain: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing to do now.
    Idle,
    /// Delegate the program-owned target to `validator`.
    Delegate { validator: Key },
    /// Schedule a commit on the ER.
    Commit,
    /// Schedule commit-and-undelegate: the session ends (budget, rotation
    /// or drain); a new one follows unless draining.
    EndSession { why: EndWhy },
    /// Wait; nothing may be sent (the reconciler holds or stops).
    Wait,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndWhy {
    Budget,
    Rotation,
    Drain,
}

/// `delegated_to`: the record's validator if delegated; `commits`: the
/// session's finalized commits; `dirty`: the ER copy is ahead of the base.
pub fn next(p: &Plan, d: &Decision, delegated_to: Option<Key>, commits: u32, dirty: bool) -> Step {
    match d {
        Decision::Base { .. } => {
            if p.drain {
                Step::Idle
            } else {
                Step::Delegate {
                    validator: p.preferred,
                }
            }
        }
        Decision::Er { .. } => {
            if p.drain {
                return Step::EndSession { why: EndWhy::Drain };
            }
            if delegated_to.is_some_and(|v| v != p.preferred) {
                return Step::EndSession {
                    why: EndWhy::Rotation,
                };
            }
            if commits >= p.commits_per_session {
                return Step::EndSession {
                    why: EndWhy::Budget,
                };
            }
            if dirty {
                Step::Commit
            } else {
                Step::Idle
            }
        }
        Decision::Hold(Hold::NotCloned) => Step::Idle,
        Decision::Hold(_) | Decision::Stop(_) => Step::Wait,
    }
}
