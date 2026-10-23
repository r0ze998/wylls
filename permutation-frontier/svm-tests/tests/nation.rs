//! S1 stage 1e: nations (`docs/frontier/stage1e/S1-1E-CONTRACT.md` §3) on
//! the test-beacon build: Propose, Vote and SettleProposal — a stance
//! written into the Season, an expulsion and a readmission (the Citizen's
//! `EXPELLED_SINCE` and its holdings' `FLAG_EXPELLED`), and the refusals.
//!
//! Crafted state: four villages of faction 0 (A, B, C, D) on sites 0–3 of
//! one ring-4 Province (`world::conquest` estates); their `JOIN_BELL` is
//! set to 0 so they are eligible from bell `ELIGIBLE_BELLS`.

mod common;

use fclient::ix::v2 as fx;
use frontier_abi::v2::layout::player::{citizen as C, holding as H2};
use frontier_abi::v2::layout::s1::{nation as NA, proposal as PR};
use frontier_abi::v2::layout::world::season as S2;
use frontier_abi::v2::log::{AnyKind, CqKind};
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{i64_at, u32_at, Estate};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{FrontierError as E, Instruction, Keypair, Signer};
use permutation_rules::frontier::nation::{
    self as kn, Proposal, KIND_EXPEL, KIND_READMIT, KIND_STANCE, STATE_FAILED, STATE_OPEN,
    STATE_PASSED,
};
use permutation_rules::frontier::structure::{STANCE_ALLY, STANCE_PASS};

/// The first bell every village is eligible at.
const B0: u32 = kn::ELIGIBLE_BELLS + 2;

fn s1_send(c: &mut Chain, kind: I2, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let (bytes, n) = frontier_abi::v2::budgets::loaded_accounts(kind);
    let loaded = permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), bytes, n)
        .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT);
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(loaded);
    c.send_with(&p, &[ix], signers)
}

/// Four villages of faction 0 in one Province, eligible at `B0`.
struct Nation {
    c: Chain,
    w: World,
    v: Vec<Estate>,
}

impl Nation {
    fn new() -> Nation {
        let mut c = Chain::new(Build::TestBeacon);
        let w = World::running(&mut c, 1);
        w.cq_set_params(&mut c, &MC_LOCAL_7D.cq);
        w.to_bell(&mut c, 5, 5);
        let t = provinces_of(4, Some(0))[0];
        let v: Vec<Estate> = ["a", "b", "c", "d"]
            .iter()
            .enumerate()
            .map(|(i, l)| w.cq_estate(&mut c, l, 0, t, i as u8))
            .collect();
        for e in &v {
            c.edit(&e.citizen, |d| d[C::JOIN_BELL..C::JOIN_BELL + 4].fill(0));
        }
        w.to_bell(&mut c, B0, 5);
        Nation { c, w, v }
    }

    fn nation(&self) -> permutation_frontier_svm_tests::Address {
        self.w.a.nation(0)
    }

    fn propose(
        &mut self,
        i: usize,
        kind: u8,
        tf: u8,
        value: u8,
        target: Option<usize>,
    ) -> SendResult {
        let e = &self.v[i];
        let target = target.map(|t| self.v[t].citizen);
        let ix = fx::propose(&self.w.a, &e.player(), 0, kind, tf, value, target);
        let k = e.wallet.insecure_clone();
        s1_send(&mut self.c, I2::Propose, ix, &[&k])
    }

    fn vote(&mut self, i: usize, slot: u8, id: u32, yes: bool) -> SendResult {
        let e = &self.v[i];
        let ix = fx::vote(&self.w.a, &e.player(), 0, slot, id, yes);
        let k = e.wallet.insecure_clone();
        s1_send(&mut self.c, I2::Vote, ix, &[&k])
    }

    fn settle(
        &mut self,
        slot: u8,
        id: u32,
        target: Option<usize>,
        holdings: &[usize],
    ) -> SendResult {
        let target_c = target.map(|t| self.v[t].citizen);
        let hs: Vec<_> = holdings.iter().map(|&h| self.v[h].href()).collect();
        let keeper = self.w.keeper.insecure_clone();
        let ix = fx::settle_proposal(&self.w.a, keeper.pubkey(), 0, slot, id, target_c, &hs);
        s1_send(&mut self.c, I2::SettleProposal, ix, &[&keeper])
    }

    fn proposal(&self, slot: usize) -> Proposal {
        let d = self.c.data(&self.nation());
        Proposal::decode(&d[NA::at(slot)..]).unwrap()
    }

    fn stance(&self, nation: u8, faction: u8) -> u8 {
        self.c.data(&self.w.a.season)[S2::STANCES + nation as usize * 6 + faction as usize]
    }

    fn past_close(&mut self, slot: usize) {
        let close = self.proposal(slot).close_bell;
        self.w.to_bell(&mut self.c, close, 5);
    }
}

/// Within the instruction's budget row (`frontier_abi::v2::budgets`).
#[track_caller]
fn within_budget(l: &Landed, ix: I2) {
    let b = frontier_abi::v2::budgets::budget(ix).cu_limit as u64;
    println!("{}: {} CU (row {b})", ix.name(), l.cu);
    assert!(l.cu <= b, "{}: {} CU over {b}", ix.name(), l.cu);
}

#[track_caller]
fn event(l: &Landed, k: CqKind) -> fclient::conquest::CqEvent {
    let _ = records::one_cq(&l.logs, k);
    let body = records::bodies(&l.logs)
        .into_iter()
        .find(|b| frontier_abi::v2::log::decode(b).is_ok_and(|r| r.kind == AnyKind::Cq(k)))
        .expect("the body");
    fclient::conquest::parse(&body)
        .expect("fclient parses it")
        .event
}

// ------------------------------------------------------------ stances

/// A stance proposal creates the Nation, takes votes (one a Citizen) and,
/// once closed and passed, writes the Season's stance.
#[test]
fn g13_s1_a_passed_stance_is_written_into_the_season() {
    let mut n = Nation::new();
    assert!(n.c.is_absent(&n.nation()));
    let l = expect_lands(n.propose(0, KIND_STANCE, 3, STANCE_PASS, None), "Propose");
    within_budget(&l, I2::Propose);
    let nd = n.c.data(&n.nation());
    assert_eq!(nd[NA::FACTION], 0);
    assert_eq!(u32_at(&nd, NA::NEXT_ID), 2);
    let q = n.proposal(0);
    assert_eq!(
        (q.id, q.state, q.kind, q.target_faction, q.value),
        (1, STATE_OPEN, KIND_STANCE, 3, STANCE_PASS)
    );
    assert_eq!(q.close_bell, q.open_bell + kn::WINDOW_BELLS);
    assert_eq!(q.proposer_tag, n.v[0].citizen_tag());
    assert_eq!(u32_at(&n.c.data(&n.v[0].citizen), C::PROPOSED), 1);
    match event(&l, CqKind::NATION_PROPOSED) {
        fclient::conquest::CqEvent::NationProposed {
            faction,
            id,
            slot,
            kind,
            target_faction,
            value,
            proposer_tag,
            target_tag,
            close_bell,
        } => assert_eq!(
            (
                faction,
                id,
                slot,
                kind,
                target_faction,
                value,
                proposer_tag,
                target_tag,
                close_bell
            ),
            (
                0,
                1,
                0,
                KIND_STANCE,
                3,
                STANCE_PASS,
                n.v[0].citizen_tag(),
                0,
                q.close_bell
            )
        ),
        e => panic!("{e:?}"),
    }
    // Votes: three yes, one no; a second vote is refused.
    for i in 0..3 {
        expect_lands(n.vote(i, 0, 1, true), "Vote yes");
    }
    assert_code(n.vote(0, 0, 1, false), E::AlreadyDone);
    let l = expect_lands(n.vote(3, 0, 1, false), "Vote no");
    within_budget(&l, I2::Vote);
    match event(&l, CqKind::NATION_VOTED) {
        fclient::conquest::CqEvent::NationVoted {
            voter_tag,
            yes,
            yes_now,
            no_now,
            ..
        } => assert_eq!(
            (voter_tag, yes, yes_now, no_now),
            (n.v[3].citizen_tag(), false, 3, 1)
        ),
        e => panic!("{e:?}"),
    }
    assert_eq!(u32_at(&n.c.data(&n.v[3].citizen), C::VOTED), 1);
    // Not before it closes.
    assert_cq(n.settle(0, 1, None, &[]), Cq::ProposalState);
    n.past_close(0);
    assert_cq(n.vote(3, 0, 1, true), Cq::ProposalState);
    assert_eq!(n.stance(0, 3), 0);
    // Listing holdings for a stance is refused.
    assert_code(n.settle(0, 1, None, &[0]), E::TooManyAccounts);
    let l = expect_lands(n.settle(0, 1, None, &[]), "SettleProposal");
    within_budget(&l, I2::SettleProposal);
    assert_eq!(n.stance(0, 3), STANCE_PASS, "the Season's stance");
    assert_eq!(n.stance(3, 0), 0, "one-sided");
    assert_eq!(n.proposal(0).state, STATE_PASSED);
    match event(&l, CqKind::NATION_DECIDED) {
        fclient::conquest::CqEvent::NationDecided {
            passed,
            kind,
            target_faction,
            value,
            yes,
            no,
            holdings,
            ..
        } => assert_eq!(
            (passed, kind, target_faction, value, yes, no, holdings),
            (true, KIND_STANCE, 3, STANCE_PASS, 3, 1, [0; 3])
        ),
        e => panic!("{e:?}"),
    }
    // Settled once.
    assert_cq(n.settle(0, 1, None, &[]), Cq::ProposalState);
    // The slot is free again: the next proposal takes it with a new id.
    expect_lands(
        n.propose(1, KIND_STANCE, 3, STANCE_ALLY, None),
        "Propose again",
    );
    assert_eq!((n.proposal(0).id, n.proposal(0).state), (2, STATE_OPEN));
}

/// Short of the quorum, or with as many no as yes, a proposal fails and
/// changes nothing.
#[test]
fn g13_s1_a_failed_proposal_changes_nothing() {
    let mut n = Nation::new();
    expect_lands(n.propose(0, KIND_STANCE, 2, STANCE_PASS, None), "Propose");
    expect_lands(n.vote(0, 0, 1, true), "Vote");
    expect_lands(n.vote(1, 0, 1, true), "Vote");
    n.past_close(0);
    let l = expect_lands(n.settle(0, 1, None, &[]), "SettleProposal");
    assert_eq!(n.proposal(0).state, STATE_FAILED);
    assert_eq!(n.stance(0, 2), 0);
    match event(&l, CqKind::NATION_DECIDED) {
        fclient::conquest::CqEvent::NationDecided {
            passed, yes, no, ..
        } => {
            assert_eq!((passed, yes, no), (false, 2, 0))
        }
        e => panic!("{e:?}"),
    }
    // 3 yes against 3 no: a tie fails too (only four villages here, so
    // the tallies are crafted).
    expect_lands(n.propose(1, KIND_STANCE, 2, STANCE_PASS, None), "Propose");
    let id = n.proposal(0).id;
    n.c.edit(&n.nation(), |d| {
        let o = NA::at(0);
        d[o + PR::YES..o + PR::YES + 2].copy_from_slice(&3u16.to_le_bytes());
        d[o + PR::NO..o + PR::NO + 2].copy_from_slice(&3u16.to_le_bytes());
    });
    n.past_close(0);
    expect_lands(n.settle(0, id, None, &[]), "SettleProposal");
    assert_eq!(n.proposal(0).state, STATE_FAILED);
}

#[test]
fn g13_s1_propose_and_vote_refusals() {
    let mut n = Nation::new();
    // Not yet eligible.
    let late = n.v[3].citizen;
    let bell = n.w.bell_at(n.c.now).unwrap();
    n.c.edit(&late, |d| {
        d[C::JOIN_BELL..C::JOIN_BELL + 4].copy_from_slice(&bell.to_le_bytes())
    });
    assert_cq(
        n.propose(3, KIND_STANCE, 1, STANCE_PASS, None),
        Cq::NotVoter,
    );
    // A stance toward its own faction, or no such stance, or a bad kind.
    assert_code(n.propose(0, KIND_STANCE, 0, STANCE_PASS, None), E::BadData);
    assert_code(n.propose(0, KIND_STANCE, 1, 3, None), E::BadData);
    assert_code(n.propose(0, 9, 1, 0, None), E::BadData);
    // Expelling oneself, or a village of another faction.
    assert_code(n.propose(0, KIND_EXPEL, 0, 0, Some(0)), E::BadData);
    // Readmitting a member.
    assert_cq(n.propose(0, KIND_READMIT, 0, 0, Some(1)), Cq::ProposalState);
    // One open proposal a proposer.
    expect_lands(n.propose(0, KIND_STANCE, 1, STANCE_PASS, None), "Propose");
    assert_cq(
        n.propose(0, KIND_STANCE, 2, STANCE_PASS, None),
        Cq::ProposalState,
    );
    // The late village may not vote either.
    assert_cq(n.vote(3, 0, 1, true), Cq::NotVoter);
    // A vote on the wrong id, or on an empty slot.
    assert_cq(n.vote(1, 0, 7, true), Cq::ProposalState);
    assert_cq(n.vote(1, 2, 0, true), Cq::ProposalState);
    // Four slots: the fifth open proposal finds them full.
    n.c.edit(&late, |d| d[C::JOIN_BELL..C::JOIN_BELL + 4].fill(0));
    for i in 1..4 {
        expect_lands(
            n.propose(i, KIND_STANCE, 1 + i as u8, STANCE_PASS, None),
            "Propose",
        );
    }
    // A's proposal is still open; give A a fresh proposer state.
    n.c.edit(&n.v[0].citizen, |d| d[C::PROPOSED..C::PROPOSED + 4].fill(0));
    assert_cq(
        n.propose(0, KIND_STANCE, 5, STANCE_PASS, None),
        Cq::ProposalsFull,
    );
}

// ------------------------------------------------------------ expulsion

fn expelled_flag(c: &Chain, e: &Estate) -> bool {
    c.data(&e.holding)[H2::FLAGS] & H2::FLAG_EXPELLED != 0
}

/// A passed expulsion stamps the target's `EXPELLED_SINCE` and flags its
/// holding; the expelled village may not propose or vote; it is
/// readmitted once it has been out `READMIT_BELLS`, which clears both.
#[test]
fn g13_s1_expel_and_readmit_a_village() {
    let mut n = Nation::new();
    let l = expect_lands(n.propose(0, KIND_EXPEL, 0, 0, Some(3)), "Propose expel");
    within_budget(&l, I2::Propose);
    match event(&l, CqKind::NATION_PROPOSED) {
        fclient::conquest::CqEvent::NationProposed { target_tag, .. } => {
            assert_eq!(target_tag, n.v[3].citizen_tag())
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(n.proposal(0).target, n.v[3].citizen.to_bytes());
    for i in 0..3 {
        expect_lands(n.vote(i, 0, 1, true), "Vote");
    }
    expect_lands(n.vote(3, 0, 1, false), "the target votes too");
    n.past_close(0);
    // The target's live holdings must all be listed.
    assert_code(n.settle(0, 1, Some(3), &[]), E::TooManyAccounts);
    assert_code(n.settle(0, 1, Some(3), &[3, 3]), E::TooManyAccounts);
    assert_code(n.settle(0, 1, Some(2), &[3]), E::BadAccount);
    let l = expect_lands(n.settle(0, 1, Some(3), &[3]), "SettleProposal expel");
    within_budget(&l, I2::SettleProposal);
    let since = i64_at(&n.c.data(&n.v[3].citizen), C::EXPELLED_SINCE);
    assert_eq!(since, n.c.now);
    assert!(expelled_flag(&n.c, &n.v[3]));
    assert!(!expelled_flag(&n.c, &n.v[2]));
    match event(&l, CqKind::NATION_DECIDED) {
        fclient::conquest::CqEvent::NationDecided {
            passed,
            kind,
            target_tag,
            holdings,
            ..
        } => {
            assert_eq!(
                (passed, kind, target_tag),
                (true, KIND_EXPEL, n.v[3].citizen_tag())
            );
            assert_eq!(holdings, [n.v[3].host_id(0), 0, 0]);
        }
        e => panic!("{e:?}"),
    }
    // The expelled may not propose or vote.
    assert_cq(
        n.propose(3, KIND_STANCE, 1, STANCE_PASS, None),
        Cq::NotVoter,
    );
    // Readmission: not before READMIT_BELLS.
    assert_cq(n.propose(1, KIND_READMIT, 0, 0, Some(3)), Cq::ProposalState);
    // A second expulsion of the same village is refused (not a member).
    assert_cq(n.propose(1, KIND_EXPEL, 0, 0, Some(3)), Cq::ProposalState);
    // Out long enough (crafted: the season is a week long).
    let back = n.c.now - kn::READMIT_BELLS as i64 * 600;
    n.c.edit(&n.v[3].citizen, |d| {
        d[C::EXPELLED_SINCE..C::EXPELLED_SINCE + 8].copy_from_slice(&back.to_le_bytes())
    });
    expect_lands(n.propose(1, KIND_READMIT, 0, 0, Some(3)), "Propose readmit");
    let (slot, id) = (0u8, n.proposal(0).id);
    for i in 0..3 {
        expect_lands(n.vote(i, slot, id, true), "Vote");
    }
    n.past_close(0);
    let l = expect_lands(n.settle(slot, id, Some(3), &[3]), "SettleProposal readmit");
    assert_eq!(i64_at(&n.c.data(&n.v[3].citizen), C::EXPELLED_SINCE), 0);
    assert!(!expelled_flag(&n.c, &n.v[3]));
    match event(&l, CqKind::NATION_DECIDED) {
        fclient::conquest::CqEvent::NationDecided { passed, kind, .. } => {
            assert_eq!((passed, kind), (true, KIND_READMIT))
        }
        e => panic!("{e:?}"),
    }
}

/// An expulsion whose target was expelled meanwhile (by an earlier
/// proposal) settles as failed and lists no holding.
#[test]
fn g13_s1_an_expulsion_that_no_longer_applies_fails() {
    let mut n = Nation::new();
    expect_lands(n.propose(0, KIND_EXPEL, 0, 0, Some(3)), "Propose");
    expect_lands(n.propose(1, KIND_EXPEL, 0, 0, Some(3)), "Propose twice");
    for slot in 0..2u8 {
        let id = n.proposal(slot as usize).id;
        for i in 0..3 {
            expect_lands(n.vote(i, slot, id, true), "Vote");
        }
    }
    n.past_close(1);
    expect_lands(n.settle(0, 1, Some(3), &[3]), "SettleProposal (the first)");
    // The second no longer applies: failed, no holdings listed.
    assert_code(n.settle(1, 2, Some(3), &[3]), E::TooManyAccounts);
    expect_lands(
        n.settle(1, 2, Some(3), &[]),
        "SettleProposal (the second fails)",
    );
    assert_eq!(n.proposal(1).state, STATE_FAILED);
    assert!(expelled_flag(&n.c, &n.v[3]));
}
