//! The minimal path and its faults, in the model (`frontier_er::sim`):
//! delegate → writes on the ER → commit → undelegate → writes on the base,
//! with the reconciler (`guard`) deciding at each step. **Mock results**:
//! they show the reconciler's decisions against the protocol as modelled,
//! not the behaviour of MagicBlock's services.

use frontier_er::board::{self, Write, WriteErr, PAYLOAD_LEN};
use frontier_er::guard::{
    decide, Alarm, BaseObs, Decision, ErObs, Guard, Hold, Policy, RecordObs, Stop,
};
use frontier_er::outcome::{classify, in_log, Landed};
use frontier_er::sim::{
    CommitFault, Intent, Owner, Requester, SimErr, World, REQUEST_TIMEOUT_SLOTS,
};

const WORLD: u64 = 77;
const VALIDATOR: [u8; 32] = [0xAA; 32];
const OTHER: [u8; 32] = [0xBB; 32];
const PAYER: [u8; 32] = [0x11; 32];
const TARGET: [u8; 32] = [0x42; 32];
/// Policy: propose the escape after 750 base slots (~5 min) without an ER.
const ESCAPE_AFTER: u64 = 750;

/// A write built on the copy writes go to now: the ER's while it has one
/// for a delegated board, else the base's (which the ER clones).
fn nx(w: &World, p: u8) -> Write {
    let copy = match (&w.base.owner, &w.er.copy) {
        (Owner::Dlp, Some(c)) => c.as_slice(),
        _ => w.base.data.as_slice(),
    };
    Write::on(&TARGET, copy, [p; PAYLOAD_LEN], 3).unwrap()
}

/// The base as a reader sees it at `finalized` (the model's base state is
/// the finalized state; `finalized: false` stands for a `confirmed` read).
fn base_obs(w: &World, finalized: bool) -> BaseObs {
    BaseObs {
        finalized,
        slot: w.base.slot,
        owner: w.base.owner,
        header: if w.base.owner == Owner::System {
            None
        } else {
            board::header(&w.base.data)
        },
        rolled_back_at: board::rolled_back_at(&w.base.data),
        record: w.base.record.as_ref().map(|r| RecordObs {
            validator: r.validator,
            requester: r.requester,
            request_expires: r.request_expires,
            pending_commit: r.pending.is_some(),
        }),
    }
}

fn er_obs(w: &World, endpoint: &'static str) -> ErObs {
    ErObs {
        endpoint,
        reachable: w.er.up,
        identity: w.er.identity,
        slot: w.er.slot,
        header: w.er.copy.as_deref().and_then(board::header),
        writable: w.er.writable,
    }
}

fn policy(w: &World) -> Policy {
    Policy {
        validator: VALIDATOR,
        retiring: None,
        escape_after_slots: ESCAPE_AFTER,
        last_good_slot: w.base.slot,
    }
}

fn drain(w: &mut World) {
    while w.committor_step(CommitFault::None) {}
}

#[test]
fn the_minimal_path_round_trip() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    let mut applied = vec![];
    // Base: one write before delegation.
    let x = nx(&w, 1);
    w.base_write(&x).unwrap();
    applied.push(x);
    assert!(matches!(
        decide(&base_obs(&w, true), &[], &policy(&w)),
        Decision::Base { seq: 1, .. }
    ));

    // Delegate. Base writes are refused from now on.
    w.delegate(VALIDATOR, PAYER).unwrap();
    assert_eq!(w.base_write(&nx(&w, 2)), Err(SimErr::NotProgramOwned));
    // Before the first ER write the ER has no copy.
    assert_eq!(
        decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w)),
        Decision::Hold(Hold::NotCloned)
    );
    // Writes on the ER (the first one clones the account).
    for p in [2u8, 3, 4] {
        let x = nx(&w, p);
        w.er_write(&x).unwrap();
        applied.push(x);
    }
    match decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w)) {
        Decision::Er {
            endpoint,
            live,
            committed,
            alarms,
        } => {
            assert_eq!((endpoint, live, committed), ("er", 4, 1));
            assert!(alarms.is_empty());
        }
        d => panic!("{d:?}"),
    }

    // Commit: the base copy catches up; the record stays.
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    assert_eq!(board::header(&w.base.data).unwrap().0, 4);
    assert_eq!(w.base.owner, Owner::Dlp);

    // Commit and undelegate: the ER copy freezes at once.
    let x = nx(&w, 5);
    w.er_write(&x).unwrap();
    applied.push(x);
    w.er_schedule(Intent::CommitAndUndelegate).unwrap();
    assert_eq!(w.er_write(&nx(&w, 6)), Err(SimErr::ErNotWritable));
    assert!(matches!(
        decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w)),
        Decision::Hold(Hold::Undelegating {
            requester: Requester::Validator,
            ..
        })
    ));
    drain(&mut w);
    assert_eq!(w.base.owner, Owner::Program);
    assert!(w.base.record.is_none());

    // Base resumes where the ER stopped.
    assert!(matches!(
        decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w)),
        Decision::Base { seq: 5, .. }
    ));
    let x = nx(&w, 6);
    w.base_write(&x).unwrap();
    applied.push(x);

    // Every honest copy is the replay of the writes in order, across layers.
    let replay = board::replay(WORLD, &applied).unwrap();
    assert_eq!(board::header(&w.base.data), board::header(&replay));
}

#[test]
fn a_delegate_whose_response_was_lost_is_not_sent_twice() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap(); // landed, sender saw a timeout
                                           // The sender's next step reads the base before acting: delegated to the
                                           // named validator, so it does not delegate again…
    let d = decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w));
    assert_eq!(d, Decision::Hold(Hold::NotCloned));
    // …and if it did, the program refuses (the board is not program-owned).
    assert_eq!(w.delegate(VALIDATOR, PAYER), Err(SimErr::AlreadyDelegated));
}

#[test]
fn a_confirmed_read_is_not_enough_to_act() {
    let w = World::new(WORLD, VALIDATOR, PAYER);
    assert_eq!(
        decide(&base_obs(&w, false), &[], &policy(&w)),
        Decision::Hold(Hold::BaseNotFinal)
    );
}

#[test]
fn a_committor_crash_between_commit_state_and_finalize_holds_then_completes() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_schedule(Intent::CommitAndUndelegate).unwrap();
    assert!(w.committor_step(CommitFault::AfterCommitState));
    // The validator is down with a pending diff on the base.
    assert_eq!(
        decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w)),
        Decision::Hold(Hold::CommitInFlight)
    );
    // Base writes stay refused: the base never takes over by itself.
    assert_eq!(w.base_write(&nx(&w, 2)), Err(SimErr::NotProgramOwned));
    w.er_restart();
    drain(&mut w);
    assert_eq!(w.base.owner, Owner::Program);
    assert_eq!(board::header(&w.base.data).unwrap().0, 1);
}

#[test]
fn a_commit_whose_response_was_lost_is_resent_and_ignored() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_schedule(Intent::Commit).unwrap();
    assert!(w.committor_step(CommitFault::ResponseLost));
    let after_first = w.base.clone();
    // More ER writes, then the validator resends the old commit: the nonce
    // is already finalized, so the base keeps the newer state.
    w.er_write(&nx(&w, 2)).unwrap();
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    assert_eq!(w.base.record.as_ref().unwrap().nonce, 2);
    assert_eq!(board::header(&w.base.data).unwrap().0, 2);
    assert_eq!(after_first.record.as_ref().unwrap().nonce, 1);
    assert_eq!(w.base.record.as_ref().unwrap().commits, 2);
}

#[test]
fn an_er_stop_holds_and_the_escape_restores_the_last_finalized_state() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    let mut g = Guard::new(VALIDATOR, ESCAPE_AFTER, w.base.slot);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    assert!(matches!(
        g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]),
        Decision::Er {
            live: 1,
            committed: 1,
            ..
        }
    ));
    // Two writes the base never sees, then the ER stops.
    w.er_write(&nx(&w, 2)).unwrap();
    let lost = nx(&w, 3);
    w.er_write(&lost).unwrap();
    w.er_crash();
    w.advance(10);
    match g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]) {
        Decision::Hold(Hold::ErUnreachable {
            escape_eligible: false,
            ..
        }) => {}
        d => panic!("{d:?}"),
    }
    w.advance(ESCAPE_AFTER);
    match g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]) {
        Decision::Hold(Hold::ErUnreachable {
            escape_eligible: true,
            ..
        }) => {}
        d => panic!("{d:?}"),
    }
    // A person runs the escape. Only the rent payer can request it.
    assert_eq!(w.request_undelegation(OTHER), Err(SimErr::MissingSignature));
    let expires = w.request_undelegation(PAYER).unwrap();
    assert!(matches!(
        g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]),
        Decision::Hold(Hold::Undelegating {
            requester: Requester::Owner,
            ..
        })
    ));
    assert_eq!(w.rollback_after_timeout(), Err(SimErr::TooEarly));
    w.advance(expires - w.base.slot);
    w.rollback_after_timeout().unwrap();
    // The base is back at the last finalized commit, marked.
    assert_eq!(board::header(&w.base.data).unwrap().0, 1);
    assert_eq!(board::rolled_back_at(&w.base.data), Some(1));
    // The two ER writes are lost; a sender sees its request behind the base.
    assert_eq!(
        classify(&w.base.data, &lost),
        Some(Landed::Behind { at: 1 })
    );
    // The ER comes back with its ghost copy: ignored and shown as lost.
    w.er_restart();
    match g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]) {
        Decision::Base { seq: 1, alarms } => {
            assert_eq!(
                alarms,
                vec![Alarm::GhostCopy {
                    endpoint: "er",
                    lost: 2
                }]
            );
        }
        d => panic!("{d:?}"),
    }
    // Its committor cannot bring the ghost home any more.
    let _ = w.er_schedule(Intent::Commit);
    drain(&mut w);
    assert_eq!(board::header(&w.base.data).unwrap().0, 1);
    // Base writes resume from the restored version.
    w.base_write(&nx(&w, 9)).unwrap();
}

#[test]
fn a_request_while_the_validator_is_up_undelegates_normally() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.request_undelegation(PAYER).unwrap();
    w.validator_poll();
    drain(&mut w);
    assert_eq!(w.base.owner, Owner::Program);
    assert_eq!(board::header(&w.base.data).unwrap().0, 1);
    assert_eq!(board::rolled_back_at(&w.base.data), None);
}

#[test]
fn an_rpc_switch_to_a_lagging_or_foreign_endpoint_is_not_followed() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    // A replica that stopped following at seq 1.
    let lagging = er_obs(&w, "replica");
    w.er_write(&nx(&w, 2)).unwrap();
    w.er_write(&nx(&w, 3)).unwrap();
    let primary = er_obs(&w, "primary");
    let foreign = ErObs {
        identity: OTHER,
        ..er_obs(&w, "other-er")
    };
    let p = policy(&w);
    // Only the lagging replica (and a foreign ER) answer: hold.
    let d = decide(
        &base_obs(&w, true),
        &[
            ErObs {
                header: Some((0, [0; 32])),
                ..lagging.clone()
            },
            foreign.clone(),
        ],
        &p,
    );
    assert_eq!(d, Decision::Hold(Hold::StaleEndpoints));
    // With the primary back: the primary, with the replica flagged.
    match decide(&base_obs(&w, true), &[lagging, foreign, primary], &p) {
        Decision::Er {
            endpoint,
            live,
            alarms,
            ..
        } => {
            assert_eq!((endpoint, live), ("primary", 3));
            assert!(alarms.contains(&Alarm::StaleEndpoint("replica")));
            assert!(alarms.contains(&Alarm::ForeignIdentity("other-er")));
        }
        d => panic!("{d:?}"),
    }
}

#[test]
fn a_restarted_sender_resends_the_same_request_and_it_applies_once() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    let a = nx(&w, 1);
    // A rival built on the same version, sent later by someone else.
    let b = nx(&w, 2);
    // `a` landed; the sender crashed before recording it. After restart
    // the journal has `a` as sent-unknown. It classifies by state first…
    w.er_write(&a).unwrap();
    let copy = w.er.copy.clone().unwrap();
    assert_eq!(classify(&copy, &a), Some(Landed::Yes { seq: 1 }));
    // …and a blind resend is refused as a duplicate, not applied again.
    assert_eq!(
        w.er_write(&a),
        Err(SimErr::Board(WriteErr::StaleSeq {
            at: 1,
            applied: true
        }))
    );
    // The rival built on the same version loses.
    assert_eq!(
        w.er_write(&b),
        Err(SimErr::Board(WriteErr::StaleSeq {
            at: 1,
            applied: false
        }))
    );
    // Once followed by another write, state alone says "superseded"; the
    // ER log decides.
    w.er_write(&nx(&w, 3)).unwrap();
    let copy = w.er.copy.clone().unwrap();
    assert_eq!(classify(&copy, &a), Some(Landed::Superseded { at: 2 }));
    let log: Vec<(u64, [u8; 32])> = w.er.log.iter().map(|x| (x.expect_seq, x.req_id)).collect();
    assert!(in_log(&log, a.expect_seq, &a.req_id));
    assert!(!in_log(&log, b.expect_seq, &b.req_id));
}

#[test]
fn the_same_request_sent_to_both_layers_applies_on_one() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    let a = nx(&w, 1);
    assert_eq!(w.base_write(&a), Err(SimErr::NotProgramOwned));
    w.er_write(&a).unwrap();
    w.er_schedule(Intent::CommitAndUndelegate).unwrap();
    drain(&mut w);
    // Home: the base copy carries `a`; resending it to the base is a
    // duplicate.
    assert_eq!(
        w.base_write(&a),
        Err(SimErr::Board(WriteErr::StaleSeq {
            at: 1,
            applied: true
        }))
    );
}

#[test]
fn mixed_reads_keep_live_and_committed_apart() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    for i in 0..5 {
        w.er_write(&nx(&w, i as u8)).unwrap();
    }
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    for i in 5..8 {
        w.er_write(&nx(&w, i as u8)).unwrap();
    }
    match decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w)) {
        Decision::Er {
            live: 8,
            committed: 5,
            ..
        } => {}
        d => panic!("{d:?}"),
    }
}

#[test]
fn contradictions_stop() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    // Delegated to a validator the season does not name.
    w.delegate(OTHER, PAYER).unwrap();
    assert_eq!(
        decide(&base_obs(&w, true), &[], &policy(&w)),
        Decision::Stop(Stop::UnknownValidator)
    );

    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    // An ER copy at the committed seq with another head.
    let mut e = er_obs(&w, "er");
    e.header = Some((1, [7; 32]));
    assert_eq!(
        decide(&base_obs(&w, true), &[e], &policy(&w)),
        Decision::Stop(Stop::Divergence { seq: 1 })
    );
    // An ER copy ahead of a program-owned base with no rollback mark.
    let mut w2 = World::new(WORLD, VALIDATOR, PAYER);
    w2.base_write(&nx(&w2, 1)).unwrap();
    let ahead = ErObs {
        endpoint: "er",
        reachable: true,
        identity: VALIDATOR,
        slot: 0,
        header: Some((3, [1; 32])),
        writable: true,
    };
    assert_eq!(
        decide(&base_obs(&w2, true), &[ahead], &policy(&w2)),
        Decision::Stop(Stop::UnexplainedErAhead { er: 3, base: 1 })
    );
    // A record on a program-owned account, and an owner without one.
    let mut b = base_obs(&w2, true);
    b.record = Some(RecordObs {
        validator: VALIDATOR,
        requester: Requester::None,
        request_expires: None,
        pending_commit: false,
    });
    assert_eq!(
        decide(&b, &[], &policy(&w2)),
        Decision::Stop(Stop::Inconsistent)
    );
    let mut b = base_obs(&w2, true);
    b.owner = Owner::Dlp;
    assert_eq!(
        decide(&b, &[], &policy(&w2)),
        Decision::Stop(Stop::Inconsistent)
    );
    let mut b = base_obs(&w2, true);
    b.owner = Owner::System;
    b.header = None;
    assert_eq!(
        decide(&b, &[], &policy(&w2)),
        Decision::Stop(Stop::TargetMissing)
    );
}

#[test]
fn the_sponsored_commit_cap_leaves_the_way_home_open() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    w.delegate(VALIDATOR, PAYER).unwrap();
    for i in 0..10u64 {
        w.er_write(&nx(&w, i as u8)).unwrap();
        w.er_schedule(Intent::Commit).unwrap();
        drain(&mut w);
    }
    w.er_write(&nx(&w, 10)).unwrap();
    assert_eq!(w.er_schedule(Intent::Commit), Err(SimErr::CommitCap));
    // The final commit-and-undelegate is still allowed.
    w.er_schedule(Intent::CommitAndUndelegate).unwrap();
    drain(&mut w);
    assert_eq!(w.base.owner, Owner::Program);
    assert_eq!(board::header(&w.base.data).unwrap().0, 11);
}

#[test]
fn a_target_left_on_a_stopped_er_is_reported_never_taken_back_automatically() {
    // Settlement (the prize program) reads only program-owned accounts;
    // the board is not one of its inputs. A board left on a stopped ER is
    // reported: escape eligible after the wait, never auto-taken.
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    let mut g = Guard::new(VALIDATOR, ESCAPE_AFTER, w.base.slot);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_crash();
    w.advance(REQUEST_TIMEOUT_SLOTS);
    assert!(matches!(
        g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]),
        Decision::Hold(Hold::ErUnreachable {
            escape_eligible: true,
            ..
        })
    ));
}

#[test]
fn a_wiped_er_that_lost_writes_stops_instead_of_looking_clean() {
    let mut w = World::new(WORLD, VALIDATOR, PAYER);
    let mut g = Guard::new(VALIDATOR, ESCAPE_AFTER, w.base.slot);
    w.delegate(VALIDATOR, PAYER).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    w.er_schedule(Intent::Commit).unwrap();
    drain(&mut w);
    w.er_write(&nx(&w, 2)).unwrap();
    let lost = nx(&w, 3);
    w.er_write(&lost).unwrap();
    assert!(matches!(
        g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]),
        Decision::Er {
            live: 3,
            committed: 1,
            ..
        }
    ));
    // Wiped: the ER re-clones the base copy (seq 1) on the next use, and
    // another write takes seq 2 with other content.
    w.er_wipe();
    w.er_write(&nx(&w, 9)).unwrap();
    // Without the high-water mark this would read as a clean session at 2.
    let plain = decide(&base_obs(&w, true), &[er_obs(&w, "er")], &policy(&w));
    assert!(matches!(plain, Decision::Er { live: 2, .. }));
    assert_eq!(
        g.decide(&base_obs(&w, true), &[er_obs(&w, "er")]),
        Decision::Stop(Stop::ErRegressed { seen: 3, now: 2 })
    );
    // The sender of the lost write (built on the old seq 2) sees its
    // version orphaned: same seq, other head. A resend can never apply.
    let copy = w.er.copy.clone().unwrap();
    assert_eq!(classify(&copy, &lost), Some(Landed::Orphaned { at: 2 }));
    assert!(matches!(
        w.er_write(&lost),
        Err(SimErr::Board(WriteErr::StaleSeq {
            at: 2,
            applied: false
        }))
    ));
}
