//! ⑪ (2026-11-18, the early verifier patches): a program account of a
//! layout this verifier does not model is judged by what the season's
//! program could have written, in step with V0 (⑪ r13: a forgery only
//! under a program version this verifier knows).
//!
//! - Under a known version that does not create the layout (M1's 1, S1's 4)
//!   it is a FAIL (`VR` `UnknownAccount`), as before: that program cannot
//!   have written it.
//! - Under workstream 20's `nft-experimental` version the resident policy
//!   and link are that program's own accounts: not `UnknownAccount` (V27
//!   and V28 judge them). Before this, VR called every honest JoinResident
//!   archive with post-states a FAIL.
//! - Under a version this verifier does not know (a wide-world build, a
//!   combined experimental build, a later one) nothing says the layout is
//!   impossible: UNVERIFIABLE (`UnknownAccount`), never a FAIL and never a
//!   PASS (V0 already reports `UnknownProgramVersion`).
//!
//! Key-free: the recorded `land` season with CreateSeason's
//! `program_version` and the Season states edited in place, and one
//! post-state added; nothing is generated, derived or signed.

mod common;

use common::*;
use verify_core::input::Input;
use verify_core::Severity;

fn set_version(inp: &mut Input, pv: u16) {
    use frontier_abi::layout::world::season as S1W;
    let create = (0..inp.txs.len())
        .find(|&t| {
            fclient::tx::from_wire(&inp.txs[t].tx).is_ok_and(|tx| {
                let keys = &tx.message.account_keys;
                tx.message.instructions.iter().any(|c| {
                    keys[c.program_id_index as usize] == inp.cfg.program
                        && c.data.first() == Some(&frontier_abi::tags::Ix::CreateSeason.tag())
                })
            })
        })
        .expect("the season's CreateSeason");
    verify_core::tamper::edit_ix(inp, create, frontier_abi::tags::Ix::CreateSeason, |d| {
        let o = 1 + frontier_abi::presets::layout::PROGRAM_VERSION;
        d[o..o + 2].copy_from_slice(&pv.to_le_bytes());
    });
    let fix = |a: &mut fclient::ports::Account| {
        if a.data.get(..8) == Some(&S1W::MAGIC[..]) && a.data.len() >= S1W::PROGRAM_VERSION + 2 {
            a.data[S1W::PROGRAM_VERSION..S1W::PROGRAM_VERSION + 2]
                .copy_from_slice(&pv.to_le_bytes());
        }
    };
    for t in inp.txs.iter_mut() {
        for (_, a) in t
            .post
            .iter_mut()
            .filter_map(|(k, a)| a.as_mut().map(|a| (k, a)))
        {
            fix(a);
        }
    }
    for a in inp.finals.values_mut().flatten() {
        fix(a);
    }
}

/// A successful transaction with post-states and a writable account (not
/// the program) its post-states leave out.
fn writable_without_post(base: &Input) -> (usize, fclient::Address) {
    let program = base.cfg.program;
    (0..base.txs.len())
        .filter(|&t| base.txs[t].err.is_none() && !base.txs[t].post.is_empty())
        .find_map(|t| {
            let tx = fclient::tx::from_wire(&base.txs[t].tx).ok()?;
            (0..tx.message.account_keys.len()).find_map(|i| {
                let a = tx.message.account_keys[i];
                (fclient::tx::is_writable_index(&tx.message, i)
                    && a != program
                    && !base.txs[t].post.iter().any(|(x, _)| *x == a))
                .then_some((t, a))
            })
        })
        .expect("a writable account outside a transaction's post-states")
}

/// VR's `UnknownAccount` findings, with their severities, when `t`'s
/// post-states also hold a program account with `data` at `key`.
fn vr_unknown(base: &Input, t: usize, key: fclient::Address, data: &[u8]) -> Vec<Severity> {
    let mut inp = base.clone();
    inp.txs[t].post.push((
        key,
        Some(fclient::ports::Account {
            lamports: 1,
            data: data.to_vec(),
            owner: inp.cfg.program,
            executable: false,
        }),
    ));
    let r = verify_core::verify(&inp);
    r.findings
        .iter()
        .filter(|f| f.check == "VR" && f.code == "UnknownAccount")
        .map(|f| f.severity)
        .collect()
}

fn layout(m: [u8; 8], len: usize) -> Vec<u8> {
    let mut d = vec![0u8; len];
    d[..8].copy_from_slice(&m);
    d
}

fn policy() -> Vec<u8> {
    layout(
        frontier_abi::resident_policy::MAGIC,
        frontier_abi::resident_policy::LEN,
    )
}

fn link() -> Vec<u8> {
    layout(
        frontier_abi::resident_binding::MAGIC,
        frontier_abi::resident_binding::LEN,
    )
}

fn odd() -> Vec<u8> {
    layout(*b"PSFZZZZ9", 64)
}

fn base(pv: u16) -> Input {
    let mut inp = land();
    set_version(&mut inp, pv);
    inp
}

#[test]
fn the_resident_accounts_of_the_nft_build_are_not_unknown() {
    let pv = verify_core::checks::v0_coverage::PROGRAM_VERSION_NFT_S1;
    let b = base(pv);
    let (t, k) = writable_without_post(&b);
    for (what, d) in [("policy", policy()), ("link", link())] {
        let found = vr_unknown(&b, t, k, &d);
        assert!(found.is_empty(), "{what} under {pv:#06x}: {found:?}");
    }
    // The control: a layout no ABI names is still a FAIL there.
    assert_eq!(vr_unknown(&b, t, k, &odd()), vec![Severity::Fail]);
}

#[test]
fn an_account_a_known_program_cannot_write_still_fails() {
    for pv in [1u16, frontier_abi::v2::presets::PROGRAM_VERSION_S1] {
        let b = base(pv);
        let (t, k) = writable_without_post(&b);
        for (what, d) in [("policy", policy()), ("link", link()), ("odd", odd())] {
            assert_eq!(
                vr_unknown(&b, t, k, &d),
                vec![Severity::Fail],
                "{what} under {pv}"
            );
        }
    }
}

#[test]
fn an_unknown_layout_under_an_unknown_program_is_unverifiable_not_a_fail() {
    use frontier_abi::v2::presets::PROGRAM_VERSION_S1;
    for pv in [
        5u16,
        0x4000 | PROGRAM_VERSION_S1,
        0xC000 | PROGRAM_VERSION_S1,
        0xFFFF,
    ] {
        let b = base(pv);
        let (t, k) = writable_without_post(&b);
        for (what, d) in [
            ("wide roster", layout(*b"PSFXWRO2", 256)),
            ("odd", odd()),
            ("policy", policy()),
        ] {
            let found = vr_unknown(&b, t, k, &d);
            assert_eq!(
                found,
                vec![Severity::Unverifiable],
                "{what} under {pv:#06x}"
            );
        }
    }
}
