//! A continuing world (no end, no reset): the target lives across many
//! delegation sessions, war-period boundaries, keeper restarts and a
//! validator rotation, on one `(seq, head)` chain. **Mock results** (the
//! model of `frontier_er::sim`).

use frontier_er::board::{self, Write, PAYLOAD_LEN};
use frontier_er::guard::{BaseObs, Decision, ErObs, Guard, RecordObs};
use frontier_er::plan::{next, EndWhy, Plan, Step};
use frontier_er::sim::{CommitFault, Intent, Key, Owner, SimErr, World, SPONSORED_COMMITS};

const WORLD: u64 = 1;
const V1: Key = [0xA1; 32];
const V2: Key = [0xA2; 32];
const PAYER: Key = [0x11; 32];
const TARGET: Key = [0x42; 32];
/// War periods of 144 bells in the test; nothing in the target or the
/// planner reads them.
const PERIOD_BELLS: u32 = 144;

/// A write built on the copy writes go to now (the ER's while it holds a
/// delegated board, else the base's).
fn nx(w: &World, bell: u32) -> Write {
    let copy = match (&w.base.owner, &w.er.copy) {
        (Owner::Dlp, Some(c)) => c.as_slice(),
        _ => w.base.data.as_slice(),
    };
    let mut payload = [0u8; PAYLOAD_LEN];
    payload[..4].copy_from_slice(&bell.to_le_bytes());
    Write::on(&TARGET, copy, payload, bell).unwrap()
}

fn base_obs(w: &World) -> BaseObs {
    BaseObs {
        finalized: true,
        slot: w.base.slot,
        owner: w.base.owner,
        header: board::header(&w.base.data),
        rolled_back_at: board::rolled_back_at(&w.base.data),
        record: w.base.record.as_ref().map(|r| RecordObs {
            validator: r.validator,
            requester: r.requester,
            request_expires: r.request_expires,
            pending_commit: r.pending.is_some(),
        }),
    }
}

fn er_obs(w: &World) -> ErObs {
    ErObs {
        endpoint: "er",
        reachable: w.er.up,
        identity: w.er.identity,
        slot: w.er.slot,
        header: w.er.copy.as_deref().and_then(board::header),
        writable: w.er.writable,
    }
}

/// One keeper pass: observe, decide, act, let the committor run.
fn keeper(w: &mut World, g: &mut Guard, p: &Plan) -> Step {
    let d = g.decide(&base_obs(w), &[er_obs(w)]);
    let rec = w.base.record.as_ref();
    let dirty = match (&d, rec) {
        (
            Decision::Er {
                live, committed, ..
            },
            _,
        ) => live > committed,
        _ => false,
    };
    let step = next(
        p,
        &d,
        rec.map(|r| r.validator),
        rec.map(|r| r.commits).unwrap_or(0),
        dirty,
    );
    match &step {
        Step::Delegate { validator } => w.delegate(*validator, PAYER).unwrap(),
        Step::Commit => {
            w.er_schedule(Intent::Commit).unwrap();
        }
        Step::EndSession { .. } => {
            w.er_schedule(Intent::CommitAndUndelegate).unwrap();
        }
        Step::Idle | Step::Wait => {}
    }
    while w.committor_step(CommitFault::None) {}
    step
}

/// Writes where the reconciler routes them, built on that copy; `None`
/// if it holds.
fn player_write(w: &mut World, g: &mut Guard, bell: u32) -> Option<(u64, Write)> {
    let wr = nx(w, bell);
    let r = match g.decide(&base_obs(w), &[er_obs(w)]) {
        Decision::Base { .. } => w.base_write(&wr).ok(),
        Decision::Er { .. } => w.er_write(&wr).ok(),
        // Not cloned yet: the first ER write clones it.
        Decision::Hold(frontier_er::guard::Hold::NotCloned) => w.er_write(&wr).ok(),
        _ => None,
    };
    r.map(|s| (s, wr))
}

#[test]
fn many_sessions_and_period_boundaries_on_one_chain() {
    let mut w = World::new(WORLD, V1, PAYER);
    let mut g = Guard::new(V1, 750, w.base.slot);
    let p = Plan::new(V1);
    let mut applied: Vec<Write> = vec![];
    let mut seq = 0u64;
    let mut sessions = 0u32;
    let mut ends = vec![];
    let mut retried = 0u32;
    // Ten war periods of 144 bells, a write every bell, a keeper pass
    // every 12 bells (two hours of game time).
    for bell in 0..PERIOD_BELLS * 10 {
        match player_write(&mut w, &mut g, bell) {
            Some((s, wr)) => {
                assert_eq!(s, seq + 1);
                applied.push(wr);
                seq += 1;
            }
            // Between sessions: the sender retries after the keeper pass.
            None => retried += 1,
        }
        if bell % 12 == 11 {
            match keeper(&mut w, &mut g, &p) {
                Step::Delegate { .. } => sessions += 1,
                Step::EndSession { why } => ends.push(why),
                _ => {}
            }
        }
        if let Some(r) = &w.base.record {
            assert!(
                r.commits < SPONSORED_COMMITS,
                "a session never needs commit 11"
            );
        }
    }
    // Bring it home and compare with the replay of every write, across all
    // sessions and period boundaries.
    let mut drain = p.clone();
    drain.drain = true;
    for _ in 0..3 {
        keeper(&mut w, &mut g, &drain);
    }
    assert_eq!(w.base.owner, Owner::Program);
    let replay = board::replay(WORLD, &applied).unwrap();
    assert_eq!(board::header(&w.base.data), board::header(&replay));
    assert_eq!(board::header(&w.base.data).unwrap().0, seq);
    // The account never grows: one fixed-size board for the world's life.
    assert_eq!(w.base.data.len(), board::SIZE);
    assert!(sessions >= 10, "sessions {sessions}");
    assert!(ends.iter().all(|e| *e == EndWhy::Budget));
    // Writes refused between sessions are few, and none was lost (each was
    // the same request resent).
    assert_eq!(applied.len() as u64, seq);
    assert!(
        retried < sessions * 2,
        "retried {retried} sessions {sessions}"
    );
}

#[test]
fn a_keeper_restart_mid_rotation_neither_doubles_nor_drops_a_step() {
    let mut w = World::new(WORLD, V1, PAYER);
    let p = Plan::new(V1);
    let mut g = Guard::new(V1, 750, w.base.slot);
    keeper(&mut w, &mut g, &p); // delegate
    w.er_write(&nx(&w, 0)).unwrap();
    // The keeper schedules the end of the session and dies before the
    // committor runs.
    w.er_schedule(Intent::CommitAndUndelegate).unwrap();
    // A new keeper (no memory) observes: the target is on its way home.
    let mut g2 = Guard::new(V1, 750, w.base.slot);
    assert_eq!(keeper(&mut w, &mut g2, &p), Step::Wait);
    // The committor finished in that pass; the next pass delegates once.
    assert!(matches!(keeper(&mut w, &mut g2, &p), Step::Delegate { .. }));
    // A third keeper racing it is refused by the program.
    assert_eq!(w.delegate(V1, PAYER), Err(SimErr::AlreadyDelegated));
    assert_eq!(board::header(&w.base.data).unwrap().0, 1);
}

#[test]
fn a_validator_rotation_brings_the_target_home_and_sends_it_to_the_new_one() {
    let mut w = World::new(WORLD, V1, PAYER);
    let mut g = Guard::new(V1, 750, w.base.slot);
    keeper(&mut w, &mut g, &Plan::new(V1));
    w.er_write(&nx(&w, 0)).unwrap();
    w.er_write(&nx(&w, 1)).unwrap();
    // The world rotates to V2; V1 stays trusted until the target is home.
    g.policy.validator = V2;
    g.policy.retiring = Some(V1);
    let p = Plan::new(V2);
    assert_eq!(
        keeper(&mut w, &mut g, &p),
        Step::EndSession {
            why: EndWhy::Rotation
        }
    );
    assert_eq!(w.base.owner, Owner::Program);
    assert_eq!(board::header(&w.base.data).unwrap().0, 2);
    w.switch_er(V2);
    g.policy.retiring = None;
    assert_eq!(keeper(&mut w, &mut g, &p), Step::Delegate { validator: V2 });
    w.er_write(&nx(&w, 2)).unwrap();
    assert_eq!(w.er.copy.as_deref().and_then(board::header).unwrap().0, 3);
    // Without the retiring entry, a target still with V1 would stop.
    let mut w1 = World::new(WORLD, V1, PAYER);
    w1.delegate(V1, PAYER).unwrap();
    let mut g1 = Guard::new(V2, 750, w1.base.slot);
    assert_eq!(
        g1.decide(&base_obs(&w1), &[]),
        Decision::Stop(frontier_er::guard::Stop::UnknownValidator)
    );
}

#[test]
fn a_period_boundary_inside_a_session_changes_nothing() {
    let mut w = World::new(WORLD, V1, PAYER);
    let mut g = Guard::new(V1, 750, w.base.slot);
    let p = Plan::new(V1);
    keeper(&mut w, &mut g, &p);
    let before = PERIOD_BELLS - 1;
    w.er_write(&nx(&w, before)).unwrap();
    // The planner's input has no bell: the boundary cannot trigger it.
    assert_eq!(keeper(&mut w, &mut g, &p), Step::Commit);
    w.er_write(&nx(&w, PERIOD_BELLS)).unwrap();
    assert!(matches!(
        g.decide(&base_obs(&w), &[er_obs(&w)]),
        Decision::Er {
            live: 2,
            committed: 1,
            ..
        }
    ));
    assert_eq!(w.base.owner, Owner::Dlp);
}
