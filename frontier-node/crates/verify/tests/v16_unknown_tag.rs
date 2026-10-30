//! ⑯ independent verification (cross-cutting X2): a landed Frontier
//! instruction whose tag the verifier does not know (a reserved or future
//! tag) must not pass unjudged. The verifier collects every top-level
//! program instruction (`world.rs`), then every check resolves the tag
//! with `Ix::from_tag` and `continue`s on `None`; V2 warns only when a
//! transaction carries no program instruction at all. So a run with an
//! unknown-tag instruction can PASS. This is the concrete form of "a
//! program with new processing claims the old ruleset hash" and of "a new
//! tag added to the verifier's table without a judgement".

mod common;

use common::*;
use fclient::ports::TxRecord;
use fclient::{Keypair, Signer};
use verify_core::Verdict;

/// The recorded program season with one more landed transaction: a Frontier
/// instruction of tag `tag` (data `[tag, 0, 0, 0]`) on the Season account,
/// signed by a fresh key, no logs, no post-states.
fn with_injected_tag(tag: u8) -> verify_core::input::Input {
    let mut inp = march_program();
    let last = inp.txs.last().expect("transaction").clone();
    let signer = Keypair::new_from_array([0x16; 32]);
    let a = fclient::addr::Addresses::new(inp.cfg.program, inp.cfg.season_id);
    let ix = fclient::Instruction {
        program_id: inp.cfg.program,
        accounts: vec![
            fclient::AccountMeta::new(signer.pubkey(), true),
            fclient::AccountMeta::new_readonly(a.season, false),
        ],
        data: vec![tag, 0, 0, 0],
    };
    let t = fclient::tx::build(
        &[ix],
        &fclient::tx::TxBudget {
            cu_limit: 30_000,
            cu_price: 0,
            loaded_limit: 1 << 20,
            heap: None,
        },
        &[&signer],
        &fclient::Hash::new_from_array([0x16; 32]),
    )
    .expect("transaction");
    inp.txs.push(TxRecord {
        seq: last.seq + 1,
        slot: last.slot + 1,
        signature: fclient::tx::signature(&t),
        block_time: last.block_time + 1,
        tx: fclient::tx::wire(&t),
        logs: fclient::log::in_frame(&inp.cfg.program, []),
        err: None,
        code: None,
        units: 0,
        fee: fclient::tx::fee_lamports(&t.message),
        post: vec![],
    });
    inp
}

#[test]
fn v16_x2_a_landed_instruction_of_a_reserved_tag_is_not_a_pass() {
    // 0xBF is reserved (frontier-abi v2 tags.rs `is_reserved`): the program of this recording refuses it, so a
    // recording that says it landed is a lie the verifier must catch, or at least must not call PASS.
    let r = verify_core::verify(&with_injected_tag(0xBF));
    assert_ne!(
        r.verdict,
        Verdict::Pass,
        "an unjudged instruction must not PASS:\n{}",
        show(&r)
    );
}

#[test]
fn v16_x2b_a_landed_instruction_of_an_unknown_future_tag_is_not_a_pass() {
    // 0xE0 is not in the v2 table at all: a future program's instruction in a season that claims this ruleset.
    let r = verify_core::verify(&with_injected_tag(0xE0));
    assert_ne!(
        r.verdict,
        Verdict::Pass,
        "an unjudged instruction must not PASS:\n{}",
        show(&r)
    );
}

/// A transaction shaped like ③'s courier path: the only top-level
/// instruction belongs to another program, which lists the Frontier program
/// (a CPI target) among its accounts; the Frontier records would be in an
/// inner frame. The verifier collects top-level Frontier instructions only
/// (`world.rs`), so nothing of this transaction is judged.
fn with_cpi_shaped_tx() -> verify_core::input::Input {
    let mut inp = march_program();
    let last = inp.txs.last().expect("transaction").clone();
    let signer = Keypair::new_from_array([0x17; 32]);
    let courier = fclient::Address::new_from_array([0xC0; 32]);
    let a = fclient::addr::Addresses::new(inp.cfg.program, inp.cfg.season_id);
    let ix = fclient::Instruction {
        program_id: courier,
        accounts: vec![
            fclient::AccountMeta::new_readonly(inp.cfg.program, false),
            fclient::AccountMeta::new(signer.pubkey(), true),
            fclient::AccountMeta::new_readonly(a.season, false),
        ],
        data: vec![0, 1, 0xB1, 0, 0, 0],
    };
    let t = fclient::tx::build(
        &[ix],
        &fclient::tx::TxBudget {
            cu_limit: 60_000,
            cu_price: 0,
            loaded_limit: 1 << 21,
            heap: None,
        },
        &[&signer],
        &fclient::Hash::new_from_array([0x17; 32]),
    )
    .expect("transaction");
    inp.txs.push(TxRecord {
        seq: last.seq + 1,
        slot: last.slot + 1,
        signature: fclient::tx::signature(&t),
        block_time: last.block_time + 1,
        tx: fclient::tx::wire(&t),
        logs: fclient::log::in_frame(&courier, []),
        err: None,
        code: None,
        units: 0,
        fee: fclient::tx::fee_lamports(&t.message),
        post: vec![],
    });
    inp
}

#[test]
fn v16_a8_a_cpi_shaped_transaction_leaves_nothing_judged_and_the_run_still_passes() {
    // Expected by ③'s patch 0002 (and by the verifier's own promise to re-judge every landed instruction): a Frontier
    // call reached through another program is judged or the run is not a PASS. Today it is a WARN at most.
    let r = verify_core::verify(&with_cpi_shaped_tx());
    assert_ne!(
        r.verdict,
        Verdict::Pass,
        "a transaction that reached the program only by CPI must not pass unjudged:\n{}",
        show(&r)
    );
}

#[test]
fn v16_x2_control_the_fixture_passes_untouched() {
    let r = verify_core::verify(&march_program());
    assert_eq!(r.verdict, Verdict::Pass, "{}", show(&r));
}
