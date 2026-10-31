//! V0 on the recorded fixtures (⑱, an independent patch): a successful
//! program instruction the verifier cannot judge is never a PASS. Each case
//! appends one successful transaction (or rewrites CreateSeason's version)
//! to a fixture that PASSes, and expects V0's code and a non-PASS verdict.

mod common;

use common::*;
use fclient::ports::TxRecord;
use fclient::tx::TxBudget;
use fclient::{Hash, Instruction, Keypair};
use frontier_abi::v2::tags::Ix;
use verify_core::{Input, Severity, Verdict};

const BUDGET: TxBudget = TxBudget {
    cu_limit: 400_000,
    cu_price: 0,
    loaded_limit: 1 << 20,
    heap: None,
};

/// Appends a successful transaction with one program instruction of `data`.
fn with_ix(mut inp: Input, data: Vec<u8>) -> Input {
    let last = inp.txs.last().cloned().expect("a recorded season");
    let payer = Keypair::new_from_array([0x5a; 32]);
    let ix = Instruction {
        program_id: inp.cfg.program,
        accounts: vec![],
        data,
    };
    let t = fclient::tx::build(&[ix], &BUDGET, &[&payer], &Hash::new_from_array([3; 32])).unwrap();
    inp.txs.push(TxRecord {
        seq: last.seq + 1,
        slot: last.slot + 1,
        signature: fclient::tx::signature(&t),
        block_time: last.block_time + 1,
        tx: fclient::tx::wire(&t),
        logs: vec![],
        err: None,
        code: None,
        units: 1_000,
        fee: 5_000,
        post: vec![],
    });
    inp
}

fn v0(r: &verify_core::Report) -> Vec<(Severity, String)> {
    r.findings
        .iter()
        .filter(|f| f.check == "V0")
        .map(|f| (f.severity, f.code.clone()))
        .collect()
}

#[test]
fn the_fixtures_have_nothing_for_v0() {
    for inp in [land(), march(), march_program()] {
        let r = verify_core::verify(&inp);
        assert_eq!(v0(&r), vec![], "{}", show(&r));
        assert_eq!(r.verdict, Verdict::Pass);
    }
}

#[test]
fn an_unknown_tag_fails() {
    for data in [vec![0xEE, 1, 2, 3], vec![0xA4], vec![0xAF; 9], vec![]] {
        let r = verify_core::verify(&with_ix(march(), data.clone()));
        assert_eq!(r.verdict, Verdict::Fail, "{data:?}: {}", show(&r));
        assert_eq!(
            v0(&r),
            vec![(Severity::Fail, "UnknownInstruction".into())],
            "{data:?}"
        );
    }
}

#[test]
fn missing_or_extra_data_fails() {
    // Depart with half its arguments, and Reveal with a byte too many.
    let short = vec![Ix::Depart.tag(); 20];
    let (_, hi) = frontier_abi::ix::data_len_range(Ix::Reveal.to_v1().unwrap());
    let long = vec![Ix::Reveal.tag(); hi + 1];
    for data in [short, long] {
        let r = verify_core::verify(&with_ix(march(), data));
        assert_eq!(r.verdict, Verdict::Fail, "{}", show(&r));
        assert!(
            v0(&r).contains(&(Severity::Fail, "Undecodable".into())),
            "{}",
            show(&r)
        );
    }
}

#[test]
fn an_abi_instruction_no_check_models_is_never_a_pass() {
    // FastForward and CloseMarch are in ABI v2; nothing here replays them.
    // An S1 tag in an M1 season (SendCaravan) is not modelled there either.
    for ix in [
        Ix::FastForward,
        Ix::CloseMarch,
        Ix::SendCaravan,
        Ix::DeclareSiege,
    ] {
        let (lo, _) = frontier_abi::v2::ix::data_len_range(ix);
        let mut data = vec![0u8; lo.max(1)];
        data[0] = ix.tag();
        let r = verify_core::verify(&with_ix(march(), data));
        assert_ne!(r.verdict, Verdict::Pass, "{}: {}", ix.name(), show(&r));
        assert!(
            v0(&r).contains(&(Severity::Unverifiable, "UnverifiedInstruction".into())),
            "{}: {}",
            ix.name(),
            show(&r)
        );
    }
}

#[test]
fn an_unknown_program_version_is_never_a_pass() {
    let mut inp = land();
    let i = inp
        .txs
        .iter()
        .position(|t| {
            let tx = fclient::tx::from_wire(&t.tx).unwrap();
            tx.message
                .instructions
                .iter()
                .any(|c| c.data.first() == Some(&Ix::CreateSeason.tag()))
        })
        .expect("CreateSeason recorded");
    let mut tx = fclient::tx::from_wire(&inp.txs[i].tx).unwrap();
    for c in tx.message.instructions.iter_mut() {
        if c.data.first() == Some(&Ix::CreateSeason.tag()) {
            let o = 1 + frontier_abi::presets::layout::PROGRAM_VERSION;
            c.data[o..o + 2].copy_from_slice(&5u16.to_le_bytes());
        }
    }
    inp.txs[i].tx = fclient::tx::wire(&tx);
    let r = verify_core::verify(&inp);
    assert_ne!(r.verdict, Verdict::Pass, "{}", show(&r));
    assert!(
        v0(&r).contains(&(Severity::Unverifiable, "UnknownProgramVersion".into())),
        "{}",
        show(&r)
    );
}
