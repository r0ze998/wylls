//! Reproduction of open item 4 (checkpoint verification in a continuing
//! world), reported by the ER candidate to the integrator (④): what the
//! verifier does today when the final accounts it reads are later than the
//! end of the transactions it replays, or held by the MagicBlock delegation
//! program. Current behaviour only; the proposal is in
//! `docs/frontier/er-candidate/OPEN-ITEMS.ja.md`.

mod common;

use common::*;
use verify_core::{codes, Verdict};

/// The recorded land season passes as recorded (its finals were read after
/// a quiet end).
#[test]
fn the_recorded_season_passes_with_its_quiet_end() {
    let r = verify_core::verify(&land());
    assert_eq!(r.verdict, Verdict::Pass, "{}", show(&r));
}

/// A continuing world has no quiet end: the archive ends at some point and
/// the accounts are read later. Simulated by replaying a prefix (the last
/// tenth of the transactions held back) against the same finals: today the
/// verifier fails the season with HeadMismatch (and other findings), not
/// "verified up to here".
#[test]
fn a_prefix_of_a_continuing_world_fails_today() {
    let mut inp = land();
    let keep = inp.txs.len() * 9 / 10;
    inp.txs.truncate(keep);
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Fail, "{}", show(&r));
    assert!(r.fails_with(codes::HEAD_MISMATCH), "{}", show(&r));
}

/// A chained account held by the delegation program at the time the
/// finals are read (its base bytes are the last commit) fails HeadMismatch
/// today, though its head may be exactly the replayed one.
#[test]
fn a_final_account_held_by_the_delegation_program_fails_today() {
    let mut inp = land();
    let dlp: solana_address::Address = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        .parse()
        .unwrap();
    let program = inp.cfg.program;
    let key = *inp
        .finals
        .iter()
        .find(|(_, a)| {
            a.as_ref().is_some_and(|a| {
                a.owner == program
                    && a.data
                        .get(..8)
                        .and_then(|m| {
                            frontier_abi::layout::AccountKind::from_magic(m.try_into().ok()?)
                        })
                        .is_some_and(|k| k.chained())
                    && fclient::decode::chained_header(&a.data).is_some_and(|h| h.event_seq > 0)
            })
        })
        .expect("a chained final")
        .0;
    if let Some(Some(a)) = inp.finals.get_mut(&key) {
        a.owner = dlp;
    }
    let r = verify_core::verify(&inp);
    assert!(r.fails_with(codes::HEAD_MISMATCH), "{}", show(&r));
}
