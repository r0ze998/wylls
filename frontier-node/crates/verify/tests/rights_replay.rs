//! **Workstream 02-rights (proposal, test only):** why the workshop-stock
//! swap cannot be integrated before it has PS2 records.
//!
//! An honest recorded season (`land-program.json`, which the verifier
//! passes) is extended by one injected transaction shaped exactly as a
//! successful ExecuteSwap (proposed tag 0xD2) of the 02-rights patch leaves
//! the chain: two Holdings written by `settle (no owner touch) + credit`,
//! and no PS2 record (the patch emits none). The real verifier
//! (`verify_core::verify`) then fails it with `HoldingReplayMismatch` (V7
//! holding continuity: a write by an instruction it does not know must
//! leave the accrual bytes unchanged). The control — the same transaction
//! leaving the Holdings unchanged — passes, and the kernel's own `credited`
//! reproduces the written bytes exactly from `(before, time, amounts)`:
//! the information a record must carry for a replay rule.

mod common;

use common::*;
use fclient::{AccountMeta, Instruction, Keypair, Signer};
use frontier_abi::layout::player::holding as H;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use verify_core::codes::HOLDING_REPLAY_MISMATCH;
use verify_core::holding as hr;
use verify_core::Verdict;

/// Proposed ExecuteSwap tag and data (`frontier_abi::v2::rights` in the
/// 02-rights patch; written out here so this test needs no ABI change).
const EXECUTE_SWAP: u8 = 0xD2;

fn holdings(inp: &verify_core::Input) -> Vec<([u8; 32], Vec<u8>)> {
    inp.finals
        .iter()
        .filter_map(|(k, a)| {
            let d = &a.as_ref()?.data;
            (d.len() == H::SIZE
                && d[..8] == H::MAGIC
                && d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != [0u8; 32])
                .then(|| (*k, d.clone()))
        })
        .collect()
}

/// The run with one injected ExecuteSwap-shaped transaction writing
/// `facility` and `station` (post-states given), finals updated.
fn inject(
    run: &verify_core::Input,
    facility: ([u8; 32], Vec<u8>),
    station: ([u8; 32], Vec<u8>),
    t: i64,
) -> verify_core::Input {
    let mut inp = run.clone();
    let last = inp.txs.last().expect("a transaction").clone();
    let grantee = Keypair::new_from_array([0x02; 32]);
    let program = inp.cfg.program;
    let addr = |k: [u8; 32]| fclient::Address::new_from_array(k);
    let a = fclient::addr::Addresses::new(program, inp.cfg.season_id);
    let mut data = vec![EXECUTE_SWAP];
    data.extend_from_slice(&0u16.to_le_bytes());
    let ix = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new_readonly(grantee.pubkey(), true),
            AccountMeta::new(grantee.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(addr([0x03; 32]), false), // grantee citizen
            AccountMeta::new(addr([0x04; 32]), false), // grant
            AccountMeta::new(addr(facility.0), false),
            AccountMeta::new(addr(station.0), false),
            AccountMeta::new_readonly(addr([0x05; 32]), false), // province
        ],
        data,
    };
    let tx = fclient::tx::build(
        &[ix],
        &fclient::tx::TxBudget {
            cu_limit: 60_000,
            cu_price: 0,
            loaded_limit: 1 << 20,
            heap: None,
        },
        &[&grantee],
        &fclient::Hash::new_from_array([0x21; 32]),
    )
    .expect("transaction");
    let acct = |d: Vec<u8>| {
        Some(fclient::ports::Account {
            lamports: 1,
            data: d,
            owner: program,
            executable: false,
        })
    };
    inp.txs.push(fclient::ports::TxRecord {
        seq: last.seq + 1,
        slot: last.slot + 1,
        signature: fclient::tx::signature(&tx),
        block_time: t,
        tx: fclient::tx::wire(&tx),
        // No PS2 record: the 02-rights patch emits none.
        logs: fclient::log::in_frame(&program, Vec::<String>::new()),
        err: None,
        code: None,
        units: 0,
        fee: fclient::tx::fee_lamports(&tx.message),
        post: vec![
            (addr(facility.0), acct(facility.1.clone())),
            (addr(station.0), acct(station.1.clone())),
        ],
    });
    for (k, d) in [facility, station] {
        if let Some(Some(x)) = inp.finals.get_mut(&k) {
            x.data = d;
        }
    }
    inp
}

fn codes(r: &verify_core::Report) -> Vec<String> {
    let mut v: Vec<String> = r
        .findings
        .iter()
        .filter(|f| f.fail())
        .map(|f| format!("{} {} {}", f.check, f.code, f.detail))
        .collect();
    v.sort();
    v
}

#[test]
fn an_unrecorded_swap_fails_holding_continuity_and_its_control_passes() {
    let run = land();
    assert_eq!(
        verify_core::verify(&run).verdict,
        Verdict::Pass,
        "the honest run"
    );
    let hs = holdings(&run);
    assert!(hs.len() >= 2, "two holdings in the run's final state");
    let (fk, fd) = hs[0].clone();
    let (sk, sd) = hs[1].clone();
    let t = run.txs.last().unwrap().block_time + 60;

    // Control: the same instruction writing the Holdings unchanged.
    let control = inject(&run, (fk, fd.clone()), (sk, sd.clone()), t);
    let rc = verify_core::verify(&control);
    println!(
        "control verdict {:?}, findings {:#?}",
        rc.verdict,
        codes(&rc)
    );
    assert!(
        !codes(&rc)
            .iter()
            .any(|c| c.contains(HOLDING_REPLAY_MISMATCH)),
        "control must not raise {HOLDING_REPLAY_MISMATCH}: {:#?}",
        codes(&rc)
    );

    // The swap: 3 arms to the station, 6 ore and 3 wood to the facility,
    // written as the patch writes them (settle without touch, credit).
    let mut to_station = [0i64; RESOURCES];
    to_station[Resource::Horses as usize] = 3 * MILLI; // arms' store slot
    let mut to_facility = [0i64; RESOURCES];
    to_facility[Resource::Ore as usize] = 6 * MILLI;
    to_facility[Resource::Wood as usize] = 3 * MILLI;
    let fpost = hr::credited(&fd, t, &to_facility).unwrap();
    let spost = hr::credited(&sd, t, &to_station).unwrap();
    let swap = inject(&run, (fk, fpost.clone()), (sk, spost.clone()), t);
    let r = verify_core::verify(&swap);
    let found = codes(&r);
    println!("verifier findings on the injected swap:\n{found:#?}");
    assert_eq!(r.verdict, Verdict::Fail);
    assert!(
        found.iter().any(|c| c.contains(HOLDING_REPLAY_MISMATCH)),
        "{found:#?}"
    );

    // What a replay rule would need: the kernel rebuilds both post-states
    // byte for byte from (before, block time, amounts).
    assert_eq!(
        hr::accrual_diff(&fpost, &hr::credited(&fd, t, &to_facility).unwrap()),
        None
    );
    assert_eq!(
        hr::accrual_diff(&spost, &hr::credited(&sd, t, &to_station).unwrap()),
        None
    );
    // …and without the amounts it cannot: the before-state alone differs.
    assert!(hr::accrual_diff(&spost, &sd).is_some());
}

/// IssueGrant (proposed tag 0xD0) creates a program account the verifier
/// has no kind for, and writes no Holding. Observed: the current verifier
/// **passes** the run (one informational warning): an unknown tag and an
/// unknown account are not refused, so Grant operations that write no
/// Holding (issue, revoke without escrow, close) are invisible to replay
/// rather than failing it. Pinned so a change in that behaviour is seen.
#[test]
fn an_unrecorded_grant_account_is_invisible_to_the_verifier() {
    let run = land();
    let mut inp = run.clone();
    let last = inp.txs.last().unwrap().clone();
    let issuer = Keypair::new_from_array([0x06; 32]);
    let program = inp.cfg.program;
    let a = fclient::addr::Addresses::new(program, inp.cfg.season_id);
    let grant = fclient::Address::new_from_array([0x07; 32]);
    let mut data = vec![0xD0u8];
    data.extend_from_slice(&[0u8; 4 + 1 + 2 + 4 + 8]);
    let ix = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new_readonly(issuer.pubkey(), true),
            AccountMeta::new(issuer.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(grant, false),
        ],
        data,
    };
    let tx = fclient::tx::build(
        &[ix],
        &fclient::tx::TxBudget {
            cu_limit: 60_000,
            cu_price: 0,
            loaded_limit: 1 << 20,
            heap: None,
        },
        &[&issuer],
        &fclient::Hash::new_from_array([0x22; 32]),
    )
    .unwrap();
    let mut g = vec![0u8; 272];
    g[..8].copy_from_slice(b"PSF2GRNT");
    g[8..16].copy_from_slice(&inp.cfg.season_id.to_le_bytes());
    let acct = Some(fclient::ports::Account {
        lamports: 2_784_000,
        data: g,
        owner: program,
        executable: false,
    });
    inp.txs.push(fclient::ports::TxRecord {
        seq: last.seq + 1,
        slot: last.slot + 1,
        signature: fclient::tx::signature(&tx),
        block_time: last.block_time + 60,
        tx: fclient::tx::wire(&tx),
        logs: fclient::log::in_frame(&program, Vec::<String>::new()),
        err: None,
        code: None,
        units: 0,
        fee: fclient::tx::fee_lamports(&tx.message),
        post: vec![(grant, acct.clone())],
    });
    inp.finals.insert(grant.to_bytes(), acct);
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Pass);
    assert!(r.findings.iter().all(|f| !f.fail()));
    println!(
        "verdict {:?}; all findings {:#?}",
        r.verdict,
        r.findings
            .iter()
            .map(|f| format!("{:?} {} {} {}", f.severity, f.check, f.code, f.detail))
            .collect::<Vec<_>>()
    );
}
