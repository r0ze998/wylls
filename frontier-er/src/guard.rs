//! The reconciler: from what the base layer and each ER endpoint report
//! about one target, decide where a write may go, where a reader takes the
//! state from, or that everyone must hold or stop. Pure: no I/O, no clock;
//! the keeper, the relay and the herald each feed it their own reads.
//!
//! **Never writes anything by itself.** In particular it never decides to
//! start writing on the base layer while the base says the target is
//! delegated, and it never starts the escape: [`Decision::Hold`] with
//! [`Hold::ErUnreachable`] reports `escape_eligible` once the policy's wait is
//! over, and a person runs the escape (`docs/frontier/er-candidate/RECOVERY.ja.md`).
//!
//! Inputs are the base account **read at `finalized` commitment** (a
//! `confirmed` read can still roll back, and the delegation record decides
//! who may write) plus the delegation record and metadata PDAs, and each ER
//! endpoint's identity (`getIdentity`), slot and copy of the target.

use crate::sim::{Key, Owner, Requester};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseObs {
    /// The commitment the read was made at is `finalized`.
    pub finalized: bool,
    pub slot: u64,
    pub owner: Owner,
    /// `(seq, head)` of the bytes, if they are a board.
    pub header: Option<(u64, [u8; 32])>,
    /// `Some(seq)` if the board carries the owner's rollback mark.
    pub rolled_back_at: Option<u64>,
    /// The delegation record and metadata, if present.
    pub record: Option<RecordObs>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordObs {
    pub validator: Key,
    pub requester: Requester,
    pub request_expires: Option<u64>,
    /// A commit is between CommitState and Finalize.
    pub pending_commit: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ErObs {
    pub endpoint: &'static str,
    pub reachable: bool,
    /// `getIdentity` of the endpoint.
    pub identity: Key,
    pub slot: u64,
    /// The endpoint's copy: `(seq, head)` and whether it accepts writes.
    pub header: Option<(u64, [u8; 32])>,
    pub writable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// The validator the world trusts now (the trust root for ER copies).
    /// World configuration, not a period's: it changes only by an explicit
    /// rotation (see [`crate::plan`]).
    pub validator: Key,
    /// The previous trusted validator while targets still delegated to it
    /// are brought home; `None` once none is.
    pub retiring: Option<Key>,
    /// Base slots without a usable ER before the escape may be proposed.
    pub escape_after_slots: u64,
    /// Base slot at which a usable ER copy was last seen (the caller keeps
    /// it across calls; see [`Guard`]).
    pub last_good_slot: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Writes go to the base program; reads of the live state too.
    Base { seq: u64, alarms: Vec<Alarm> },
    /// Writes go to `endpoint`; `committed` is the base copy's `seq` (what
    /// a settlement or a verifier may rely on), `live` the ER's.
    Er {
        endpoint: &'static str,
        live: u64,
        committed: u64,
        alarms: Vec<Alarm>,
    },
    /// Nobody writes; readers show the base copy as "last committed".
    Hold(Hold),
    /// Something contradicts the trust model: nobody writes, a person looks.
    Stop(Stop),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hold {
    /// The base read is not finalized yet.
    BaseNotFinal,
    /// Between CommitState and Finalize.
    CommitInFlight,
    /// Commit-and-undelegate scheduled or requested; the target is on its
    /// way home.
    Undelegating {
        requester: Requester,
        expires: Option<u64>,
    },
    /// No reachable endpoint of the named validator holds a usable copy.
    ErUnreachable { since: u64, escape_eligible: bool },
    /// The only reachable copies are older than the base's.
    StaleEndpoints,
    /// The ER has not cloned the target yet (no write reached it).
    NotCloned,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stop {
    /// The base account is gone or is not a board.
    TargetMissing,
    /// Owned by the DLP without a record, or a record while program-owned.
    Inconsistent,
    /// Delegated to a validator the world does not trust (neither the
    /// current nor the retiring one).
    UnknownValidator,
    /// Two copies at the same `seq` with different heads.
    Divergence { seq: u64 },
    /// The ER serves an older version than one already seen from it in this
    /// delegation (`seen`): it lost writes it had accepted (a wiped or
    /// replaced ER ledger re-clones the base copy). Measured on the local
    /// stack: a storage wipe drops every uncommitted write silently.
    ErRegressed { seen: u64, now: u64 },
    /// An ER copy is ahead of a program-owned base without a rollback mark:
    /// writes were accepted that never came home, and nothing records why.
    UnexplainedErAhead { er: u64, base: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Alarm {
    /// An endpoint answered with a copy older than the one chosen.
    StaleEndpoint(&'static str),
    /// An endpoint answered with another validator's identity (RPC switch
    /// to the wrong ER); ignored.
    ForeignIdentity(&'static str),
    /// After a timeout rollback, the ER still serves a copy with writes the
    /// base never received (`lost` of them); ignored, and shown as lost.
    GhostCopy { endpoint: &'static str, lost: u64 },
}

pub fn decide(base: &BaseObs, ers: &[ErObs], p: &Policy) -> Decision {
    if !base.finalized {
        return Decision::Hold(Hold::BaseNotFinal);
    }
    let Some((bseq, bhead)) = base.header else {
        return Decision::Stop(Stop::TargetMissing);
    };
    // Endpoints of the validator that holds the target (delegated), or of
    // a trusted one (program-owned: to spot copies left behind).
    let holder = base.record.as_ref().map(|r| r.validator);
    let trusted = |k: &Key| match holder {
        Some(h) => *k == h,
        None => *k == p.validator || Some(*k) == p.retiring,
    };
    let mut alarms = vec![];
    let ours: Vec<&ErObs> = ers
        .iter()
        .filter(|e| e.reachable)
        .filter(|e| {
            let ok = trusted(&e.identity);
            if !ok {
                alarms.push(Alarm::ForeignIdentity(e.endpoint));
            }
            ok
        })
        .collect();
    match base.owner {
        Owner::System => Decision::Stop(Stop::TargetMissing),
        Owner::Program => {
            if base.record.is_some() {
                return Decision::Stop(Stop::Inconsistent);
            }
            for e in &ours {
                let Some((eseq, ehead)) = e.header else {
                    continue;
                };
                if eseq == bseq && ehead != bhead {
                    return Decision::Stop(Stop::Divergence { seq: eseq });
                }
                if eseq > bseq {
                    match base.rolled_back_at {
                        Some(at) if at == bseq => alarms.push(Alarm::GhostCopy {
                            endpoint: e.endpoint,
                            lost: eseq - bseq,
                        }),
                        _ => {
                            return Decision::Stop(Stop::UnexplainedErAhead {
                                er: eseq,
                                base: bseq,
                            })
                        }
                    }
                }
            }
            Decision::Base { seq: bseq, alarms }
        }
        Owner::Dlp => {
            let Some(rec) = &base.record else {
                return Decision::Stop(Stop::Inconsistent);
            };
            if rec.validator != p.validator && Some(rec.validator) != p.retiring {
                return Decision::Stop(Stop::UnknownValidator);
            }
            if rec.pending_commit {
                return Decision::Hold(Hold::CommitInFlight);
            }
            if rec.requester != Requester::None {
                return Decision::Hold(Hold::Undelegating {
                    requester: rec.requester,
                    expires: rec.request_expires,
                });
            }
            let with_copy: Vec<(&ErObs, u64, [u8; 32])> = ours
                .iter()
                .filter_map(|e| e.header.map(|(s, h)| (*e, s, h)))
                .collect();
            if ours.is_empty() {
                let since = p.last_good_slot;
                let escape_eligible = base.slot >= since.saturating_add(p.escape_after_slots);
                return Decision::Hold(Hold::ErUnreachable {
                    since,
                    escape_eligible,
                });
            }
            if with_copy.is_empty() {
                return Decision::Hold(Hold::NotCloned);
            }
            // Same seq, different head: anywhere, between ER copies or
            // against the committed base copy.
            for (i, (_, s, h)) in with_copy.iter().enumerate() {
                if *s == bseq && *h != bhead {
                    return Decision::Stop(Stop::Divergence { seq: *s });
                }
                for (_, s2, h2) in &with_copy[..i] {
                    if s2 == s && h2 != h {
                        return Decision::Stop(Stop::Divergence { seq: *s });
                    }
                }
            }
            let best = with_copy
                .iter()
                .filter(|(e, s, _)| *s >= bseq && e.writable)
                .max_by_key(|(_, s, _)| *s);
            let Some((e, live, _)) = best else {
                return if with_copy.iter().all(|(_, s, _)| *s < bseq) {
                    Decision::Hold(Hold::StaleEndpoints)
                } else {
                    Decision::Hold(Hold::Undelegating {
                        requester: Requester::Validator,
                        expires: None,
                    })
                };
            };
            for (o, s, _) in &with_copy {
                if s < live {
                    alarms.push(Alarm::StaleEndpoint(o.endpoint));
                }
            }
            Decision::Er {
                endpoint: e.endpoint,
                live: *live,
                committed: bseq,
                alarms,
            }
        }
    }
}

/// Keeps `last_good_slot` and the ER high-water mark across calls.
#[derive(Clone, Debug)]
pub struct Guard {
    pub policy: Policy,
    /// Highest ER version seen during the current delegation; persisted by
    /// the caller with its journal so a restart keeps it.
    pub er_high: Option<u64>,
}

impl Guard {
    pub fn new(validator: Key, escape_after_slots: u64, now: u64) -> Guard {
        Guard {
            policy: Policy {
                validator,
                retiring: None,
                escape_after_slots,
                last_good_slot: now,
            },
            er_high: None,
        }
    }

    pub fn decide(&mut self, base: &BaseObs, ers: &[ErObs]) -> Decision {
        let d = decide(base, ers, &self.policy);
        match &d {
            Decision::Er { live, .. } => {
                if let Some(seen) = self.er_high.filter(|s| s > live) {
                    return Decision::Stop(Stop::ErRegressed { seen, now: *live });
                }
                self.er_high = Some(*live);
                self.policy.last_good_slot = base.slot;
            }
            Decision::Base { seq, .. } => {
                // Home: the session's writes are on the base (or recorded as
                // lost by a rollback mark); the mark restarts.
                if let Some(seen) = self.er_high.filter(|s| s > seq) {
                    if base.rolled_back_at != Some(*seq) {
                        return Decision::Stop(Stop::ErRegressed { seen, now: *seq });
                    }
                }
                self.er_high = None;
                self.policy.last_good_slot = base.slot;
            }
            _ => {}
        }
        d
    }
}
