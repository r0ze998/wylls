//! Custody (workstream 10) is not verified yet (no V26): a history that
//! carries any trace of it must never PASS. In a season whose program has
//! no custody (every ruleset up to `RULESET_HASH_V3`) such a trace is a
//! FAIL; in a custody season it is UNVERIFIABLE until V26 exists.
//!
//! The recorded fixtures are M1 and MC seasons (no S1 recording is
//! committed), so the traces are injected: a landed custody instruction, a
//! Lot account, a vault or caravan with custody fields set.

mod common;

use common::*;
use verify_core::codes::{CUSTODY_IN_PROGRAM_WITHOUT_IT, CUSTODY_UNVERIFIED};
use verify_core::Input;

const LOT_MAGIC: &[u8; 8] = b"PSF1CLOT";

/// The first landed transaction with an instruction of the program.
fn landed_with_ix(inp: &Input) -> usize {
    let program = inp.cfg.program;
    inp.txs
        .iter()
        .position(|t| {
            t.err.is_none()
                && fclient::tx::from_wire(&t.tx).is_ok_and(|tx| {
                    let keys = &tx.message.account_keys;
                    tx.message
                        .instructions
                        .iter()
                        .any(|c| keys[c.program_id_index as usize] == program)
                })
        })
        .expect("a landed program transaction")
}

/// Appends to landed transaction `t` a copy of its first program
/// instruction whose data is `data` (a forged custody instruction).
fn inject_ix(inp: &mut Input, t: usize, data: &[u8]) {
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).expect("tx");
    let program = inp.cfg.program;
    let keys = tx.message.account_keys.clone();
    let mut ci = tx
        .message
        .instructions
        .iter()
        .find(|c| keys[c.program_id_index as usize] == program)
        .expect("instruction")
        .clone();
    ci.data = data.to_vec();
    tx.message.instructions.push(ci);
    inp.txs[t].tx = fclient::tx::wire(&tx);
}

/// V26's own findings: (code, FAIL?, entity, detail, signature). The
/// fixture already FAILs elsewhere (V11), so the report's verdict says
/// nothing about custody; these do.
fn v26(r: &verify_core::Report) -> Vec<(String, bool, String, String, String)> {
    r.findings
        .iter()
        .filter(|f| f.check == "V26")
        .map(|f| {
            (
                f.code.clone(),
                f.fail(),
                f.entity.clone(),
                f.detail.clone(),
                f.signature.clone(),
            )
        })
        .collect()
}

fn verdict(inp: &Input) -> verify_core::Report {
    verify_core::verify(inp)
}

#[test]
fn baselines_are_not_flagged() {
    for (name, inp) in [("march", march()), ("land", land())] {
        let r = verdict(&inp);
        assert!(
            !r.fails_with(CUSTODY_IN_PROGRAM_WITHOUT_IT) && !r.fails_with(CUSTODY_UNVERIFIED),
            "{name}: {}",
            show(&r)
        );
    }
}

#[test]
fn a_landed_custody_instruction_in_a_season_without_custody_fails() {
    for tag in frontier_abi::v2::Ix::CUSTODY {
        let mut inp = march();
        let t = landed_with_ix(&inp);
        inject_ix(&mut inp, t, &[tag.tag()]);
        let r = verdict(&inp);
        let sig = inp.txs[t].signature.to_string();
        assert_eq!(
            v26(&r),
            vec![(
                CUSTODY_IN_PROGRAM_WITHOUT_IT.to_string(),
                true,
                "transaction".to_string(),
                format!(
                    "a landed {} instruction in a season whose program has no custody",
                    tag.name()
                ),
                sig,
            )],
            "{}: {}",
            tag.name(),
            show(&r)
        );
    }
}

#[test]
fn a_failed_custody_instruction_is_not_flagged() {
    // The v3 program refuses the tag (BadData): a failed transaction with
    // it is the program doing its job.
    let mut inp = march();
    let t = landed_with_ix(&inp);
    inject_ix(&mut inp, t, &[frontier_abi::v2::Ix::ShipLot.tag()]);
    inp.txs[t].err = Some("custom program error: 0x1".into());
    let r = verdict(&inp);
    assert!(v26(&r).is_empty(), "{}", show(&r));
}

#[test]
fn a_lot_account_in_a_season_without_custody_fails() {
    let mut inp = march();
    let program = inp.cfg.program;
    let mut data = vec![0u8; 576];
    data[..8].copy_from_slice(LOT_MAGIC);
    inp.finals.insert(
        [0xC1; 32],
        Some(fclient::ports::Account {
            lamports: 1,
            data,
            owner: program,
            executable: false,
        }),
    );
    let r = verdict(&inp);
    assert_eq!(
        v26(&r),
        vec![(
            CUSTODY_IN_PROGRAM_WITHOUT_IT.to_string(),
            true,
            format!("account:{}", fclient::Address::new_from_array([0xC1; 32])),
            "a Lot account at the pinned slot in a season whose program has no custody".to_string(),
            String::new(),
        )],
        "{}",
        show(&r)
    );
}

#[test]
fn custody_fields_in_a_vault_or_caravan_fail() {
    use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
    for (magic, size, at) in [
        (VA::MAGIC, VA::SIZE, VA::CUSTODY_LOTS),
        (CV::MAGIC, CV::SIZE, CV::CUSTODY),
    ] {
        let mut inp = march();
        let program = inp.cfg.program;
        let mut data = vec![0u8; size];
        data[..8].copy_from_slice(&magic);
        data[at] = 1;
        inp.finals.insert(
            [0xC2; 32],
            Some(fclient::ports::Account {
                lamports: 1,
                data,
                owner: program,
                executable: false,
            }),
        );
        let r = verdict(&inp);
        assert!(r.fails_with(CUSTODY_IN_PROGRAM_WITHOUT_IT), "{}", show(&r));
    }
}

#[test]
fn a_custody_season_is_never_a_pass() {
    // A season configured as custody's (RULESET_HASH_V4): any custody trace
    // is UNVERIFIABLE (no V26) or worse, never PASS.
    let mut inp = march();
    inp.cfg.ruleset_hash = frontier_abi::v2::presets::RULESET_HASH_V4;
    let t = landed_with_ix(&inp);
    inject_ix(&mut inp, t, &[frontier_abi::v2::Ix::ConsumeLot.tag()]);
    let r = verdict(&inp);
    // The fixture FAILs elsewhere already (V11), so judge V26 alone:
    // exactly one finding, UNVERIFIABLE, naming the landed instruction at
    // its transaction.
    let sig = inp.txs[t].signature.to_string();
    let v26: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.check == "V26")
        .map(|f| {
            (
                f.code.as_str(),
                f.fail(),
                f.entity.as_str(),
                f.detail.as_str(),
                f.signature.as_str(),
            )
        })
        .collect();
    assert_eq!(
        v26,
        vec![(
            CUSTODY_UNVERIFIED,
            false,
            "transaction",
            "a landed ConsumeLot instruction: custody is not verified (no V26 replay yet)",
            sig.as_str(),
        )],
        "{}",
        show(&r)
    );
}
