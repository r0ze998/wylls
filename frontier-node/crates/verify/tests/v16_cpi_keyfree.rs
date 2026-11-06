//! ⑯ independent verification of A8 (a Frontier call reached through
//! another program, or with its logs lost, must not PASS unjudged) with NO
//! key: nothing is generated, derived or signed. Injected transactions are
//! unsigned legacy messages (`Transaction::new_unsigned`, all-zero
//! signature) with constant addresses; the verifier reads archives and
//! does not check signatures. The base input is the recorded fixture
//! `march-program.json.gz` (data, loaded as is). No PDA is derived.

mod common;

use common::*;
use fclient::ports::TxRecord;
use fclient::{AccountMeta, Address, Hash, Instruction, Transaction};
use verify_core::Verdict;

const COURIER: [u8; 32] = [0xC0; 32];
const PAYER: [u8; 32] = [0xF0; 32];

/// The fixture plus one landed, unsigned transaction whose only top-level
/// instruction is another program's, naming the Frontier program among its
/// accounts, with the given logs.
fn with_courier_tx(logs: impl Fn(&Address, &Address) -> Vec<String>) -> verify_core::input::Input {
    let mut inp = march_program();
    let last = inp.txs.last().expect("transaction").clone();
    let program = inp.cfg.program;
    let courier = Address::new_from_array(COURIER);
    let payer = Address::new_from_array(PAYER);
    let ix = Instruction {
        program_id: courier,
        accounts: vec![AccountMeta::new(payer, true), AccountMeta::new_readonly(program, false)],
        data: vec![0, 1, 0xB1, 0, 0, 0],
    };
    let msg = fclient::tx::message(
        &[ix],
        &fclient::tx::TxBudget { cu_limit: 60_000, cu_price: 0, loaded_limit: 1 << 21, heap: None },
        &payer,
        &Hash::new_from_array([0x16; 32]),
    );
    let t = Transaction::new_unsigned(msg);
    inp.txs.push(TxRecord {
        seq: last.seq + 1,
        slot: last.slot + 1,
        signature: fclient::tx::signature(&t),
        block_time: last.block_time + 1,
        tx: fclient::tx::wire(&t),
        logs: logs(&courier, &program),
        err: None,
        code: None,
        units: 0,
        fee: fclient::tx::fee_lamports(&t.message),
        post: vec![],
    });
    inp
}

fn verdict(name: &str, inp: &verify_core::input::Input) -> Verdict {
    let r = verify_core::verify(inp);
    println!("{name}: {:?}\n{}", r.verdict, show(&r));
    r.verdict
}

#[test]
fn v16_k0_control_the_fixture_passes() {
    assert_eq!(verdict("k0", &march_program()), Verdict::Pass);
}

#[test]
fn v16_k1_a_nested_invocation_of_the_program_is_not_a_pass() {
    let inp = with_courier_tx(|c, p| {
        vec![
            format!("Program {c} invoke [1]"),
            format!("Program {p} invoke [2]"),
            format!("Program {p} success"),
            format!("Program {c} success"),
        ]
    });
    assert_ne!(verdict("k1", &inp), Verdict::Pass, "the program ran inside another program; its records are not judged");
}

#[test]
fn v16_k2_a_transaction_naming_the_program_with_no_logs_is_not_a_pass() {
    let inp = with_courier_tx(|_, _| vec![]);
    assert_ne!(verdict("k2", &inp), Verdict::Pass, "no logs: nothing shows whether the program ran");
}

#[test]
fn v16_k3_truncated_logs_of_a_transaction_naming_the_program_are_not_a_pass() {
    let inp = with_courier_tx(|c, _| vec![format!("Program {c} invoke [1]"), "Log truncated".to_string()]);
    assert_ne!(verdict("k3", &inp), Verdict::Pass, "the runtime cut the logs");
}

#[test]
fn v16_k4_measured_complete_logs_showing_the_program_never_ran() {
    // Not an invariant: complete logs show only the courier's frame, so the
    // program did not run. Recorded as behaviour (PASS or a warning are both
    // consistent with the logs).
    let inp = with_courier_tx(|c, _| vec![format!("Program {c} invoke [1]"), format!("Program {c} success")]);
    let v = verdict("k4", &inp);
    assert_ne!(v, Verdict::Fail, "a call that never reached the program is not a fault");
}

#[test]
fn v16_k5_a_successful_call_whose_log_tail_was_lost_is_not_a_pass() {
    let mut inp = march_program();
    let program = inp.cfg.program;
    let success = format!("Program {program} success");
    let i = inp
        .txs
        .iter()
        .rposition(|t| t.err.is_none() && t.logs.iter().any(|l| *l == success) && t.logs.iter().any(|l| l.starts_with("Program data:")))
        .expect("a successful program transaction with records");
    let logs = &mut inp.txs[i].logs;
    let cut = logs.iter().rposition(|l| *l == success).unwrap();
    logs.truncate(cut); // the tail (from the last success line on) is gone, with no runtime marker
    assert_ne!(verdict("k5", &inp), Verdict::Pass, "tx #{i}: the archive lost the end of its logs without a marker");
}
