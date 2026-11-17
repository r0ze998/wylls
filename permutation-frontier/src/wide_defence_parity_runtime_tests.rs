//! Exact host-dispatch outputs checked by the independent transition checker.
//! Literal accounts and synthetic privileges, supplied Clock/Rent, public
//! addresses only. Existing claim accounts only; every CPI attempt panics.
//! No keeper planner, exporter, key, signature, native crypto or rollback.
//! This is host consistency evidence, not authentication or whole-Season replay.
use super::*;

// Include the actual independently implemented checker, not a copy and not
// the frontier-node workspace/dependency graph. Its imports use only this
// workspace's already selected frontier-abi, permutation-rules and std.
#[path = "../../frontier-node/crates/verify/src/wide_defence.rs"]
mod checker;

const CLOCK: checker::Clock = checker::Clock {
    slot: 1011,
    epoch_start_timestamp: 0,
    epoch: 0,
    leader_schedule_epoch: 0,
    unix_timestamp: GENESIS + 6600,
};
// Pin the selected solana-rent 4.4 default used by init::rent under cfg(test).
const RENT: checker::Rent = checker::Rent {
    lamports_per_byte: 6960,
    exemption_threshold: [0, 0, 0, 0, 0, 0, 240, 63], // 1.0
    burn_percent: 50,
};
const POOL_FLOOR: u64 = (128 + DP::SIZE as u64) * 6960;

static CAPTURED: Mutex<Vec<Vec<Vec<u8>>>> = Mutex::new(Vec::new());
struct ClaimOnlyStubs;
impl solana_program::program_stubs::SyscallStubs for ClaimOnlyStubs {
    fn sol_log(&self, _message: &str) {}

    fn sol_log_data(&self, fields: &[&[u8]]) {
        // Capture every field before inspecting it. Neither prefix nor body
        // is reconstructed from expected payments or a verifier result.
        CAPTURED
            .lock()
            .unwrap()
            .push(fields.iter().map(|field| field.to_vec()).collect());
    }

    fn sol_invoke_signed(
        &self,
        _ix: &solana_program::instruction::Instruction,
        _infos: &[AccountInfo],
        _seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        panic!("existing-claim parity must never invoke another program");
    }
}

#[allow(deprecated)]
fn begin_parity() -> MutexGuard<'static, ()> {
    let guard = begin();
    solana_program::program_stubs::set_syscall_stubs(Box::new(ClaimOnlyStubs));
    CAPTURED.lock().unwrap().clear();
    let host_rent = solana_program::rent::Rent::default();
    assert_eq!(host_rent.lamports_per_byte, RENT.lamports_per_byte);
    assert_eq!(host_rent.exemption_threshold, RENT.exemption_threshold);
    assert_eq!(host_rent.burn_percent, RENT.burn_percent);
    assert_eq!(host_rent.minimum_balance(DP::SIZE), POOL_FLOOR);
    guard
}

#[allow(deprecated)]
fn images(a: &[AccountInfo<'static>]) -> Vec<checker::Account> {
    a.iter()
        .map(|a| checker::Account {
            key: a.key.to_bytes(),
            owner: a.owner.to_bytes(),
            executable: a.executable,
            // AccountInfo 3.1.1 retains only `_unused` at the former epoch
            // ABI position. Copy it exactly; this is not rent provenance.
            rent_epoch: a._unused,
            is_signer: a.is_signer,
            is_writable: a.is_writable,
            lamports: a.lamports(),
            data: a.try_borrow_data().unwrap().to_vec(),
        })
        .collect()
}

#[derive(Clone)]
struct Observed {
    instruction: Vec<u8>,
    clock: checker::Clock,
    before: Vec<checker::Account>,
    after: Vec<checker::Account>,
    prefix: Vec<u8>,
    body: Vec<u8>,
}
impl Observed {
    fn verify(&self) -> Result<checker::Verified, checker::Refusal> {
        checker::verify_transition(&checker::Transition {
            program: PROGRAM,
            season: self.before[1].key,
            instruction: &self.instruction,
            clock: self.clock,
            rent: RENT,
            before: &self.before,
            after: &self.after,
            receipt_prefix: &self.prefix,
            receipt_body: &self.body,
        })
    }
}

fn capture(a: &[AccountInfo<'static>], clock: checker::Clock) -> Observed {
    assert_eq!((a.len() - 5) % 2, 0);
    let instruction = command(((a.len() - 5) / 2) as u8);
    // The host hook consumes precisely these two fields. Remaining Clock
    // fields are supplied literals, unused by this handler/checker.
    crate::prologue::set_test_clock(clock.unix_timestamp, clock.slot);
    assert!(!crate::init::is_absent(&a[3]));
    let before = images(a);
    assert!(CAPTURED.lock().unwrap().is_empty());
    exec(a, &instruction).unwrap();
    let after = images(a);
    let mut logs = std::mem::take(&mut *CAPTURED.lock().unwrap());
    assert_eq!(logs.len(), 1, "one actual sol_log_data call");
    let fields = logs.pop().unwrap();
    assert_eq!(fields.len(), 2);
    assert_eq!(fields[0], b"PS2");
    Observed {
        instruction,
        clock,
        before,
        after,
        prefix: fields[0].clone(),
        body: fields[1].clone(),
    }
}

fn limits(a: &[AccountInfo<'static>], region: u64, day: u64, available: u64) {
    let mut pool = a[2].try_borrow_mut_data().unwrap();
    put(&mut pool, DP::PER_BELL_REGION_CAP, &region.to_le_bytes());
    put(&mut pool, DP::PER_KEEPER_DAY_CAP, &day.to_le_bytes());
    **a[2].try_borrow_mut_lamports().unwrap() = POOL_FLOOR + available;
}

fn one_slot(a: &[AccountInfo<'static>], k: usize) -> Vec<AccountInfo<'static>> {
    let mut selected = a[..5].to_vec();
    // These clones share the real pool, claim and keeper across dispatches.
    selected.extend_from_slice(&a[5 + 2 * k..7 + 2 * k]);
    selected
}

fn checked(observed: &Observed, paid: u64, partial: bool) -> checker::Verified {
    let result = observed.verify().unwrap();
    assert_eq!(result.season_id, SEASON_ID);
    assert_eq!(result.day, 0);
    assert_eq!((result.paid, result.partial), (paid, partial));
    assert_eq!(
        observed.after[0].lamports,
        observed.before[0].lamports + paid
    );
    assert_eq!(
        observed.after[2].lamports,
        observed.before[2].lamports - paid
    );
    assert!(!result.full_season());
    assert!(!result.authenticated_receipt_replay());
    assert!(!result.not_proven().is_empty());
    result
}

#[test]
fn six_dispatch_slots_match_exact_images_and_captured_receipt() {
    let _g = begin_parity();
    let a = accounts(6);
    limits(&a, 17, 25, 100);
    let observed = capture(&a, CLOCK);
    let result = checked(&observed, 17, false);
    assert_eq!(result.bell, 11);
    assert_eq!(result.slots, 6);
    assert_eq!(result.per_slot_refunds, vec![98_852; 6]);
    assert_eq!((result.region_capped, result.day_capped), (17, 17));
    assert_eq!(Ro(&observed.after[3].data).u32(DC::COUNT).unwrap(), 6);
    assert_eq!(Ro(&observed.after[2].data).u64(DP::CLAIMS).unwrap(), 6);
    for k in 0..6 {
        let i = 5 + 2 * k;
        let mut expected = observed.before[i].clone();
        expected.data[wa::wide_arrival_slot::CLAIMED] = 1;
        assert_eq!(observed.after[i], expected);
        assert_eq!(observed.after[i + 1], observed.before[i + 1]);
    }
}

#[test]
fn consecutive_dispatches_pay_seventeen_then_eight_then_zero() {
    let _g = begin_parity();
    let a = accounts(3);
    limits(&a, 17, 25, 100);
    let mut previous: Option<Observed> = None;
    for (k, (paid, cumulative)) in [(17, 17), (8, 25), (0, 25)].into_iter().enumerate() {
        let observed = capture(&one_slot(&a, k), CLOCK);
        if let Some(prev) = previous {
            assert_eq!(observed.before[..5], prev.after[..5]);
            assert_eq!(observed.before[6], prev.after[6]);
            assert_ne!(observed.before[5].key, prev.before[5].key);
        }
        let result = checked(&observed, paid, false);
        assert_eq!(result.region_capped, 17, "per-call region allowance resets");
        assert_eq!(result.day_capped, paid);
        assert_eq!(amount(&a), cumulative);
        assert_eq!(
            Ro(&observed.after[3].data).u32(DC::COUNT).unwrap(),
            k as u32 + 1
        );
        assert_eq!(
            Ro(&observed.after[2].data).u64(DP::CLAIMS).unwrap(),
            k as u64 + 1
        );
        previous = Some(observed);
    }
}

#[test]
fn partial_seven_then_supplied_refill_pays_seventeen_total_twenty_four() {
    let _g = begin_parity();
    let a = accounts(2);
    limits(&a, 17, 25, 7);
    let first = capture(&one_slot(&a, 0), CLOCK);
    let result = checked(&first, 7, true);
    assert_eq!((result.region_capped, result.day_capped), (17, 17));
    assert_eq!(first.after[2].lamports, POOL_FLOOR);

    // Explicit external balance change between the two observed transitions.
    // This is supplied pre-state, not a transfer instruction or refill proof.
    **a[2].try_borrow_mut_lamports().unwrap() += 17;
    let second = capture(&one_slot(&a, 1), CLOCK);
    for i in [0, 1, 3, 4, 6] {
        assert_eq!(second.before[i], first.after[i]);
    }
    let mut refilled = first.after[2].clone();
    refilled.lamports += 17;
    assert_eq!(second.before[2], refilled);
    let result = checked(&second, 17, false);
    assert_eq!((result.region_capped, result.day_capped), (17, 17));
    assert_eq!(
        amount(&a),
        24,
        "only actual paid amounts consume the day cap"
    );
    assert_eq!(Ro(&second.after[2].data).u64(DP::PAID_TOTAL).unwrap(), 24);
    assert_eq!(Ro(&second.after[3].data).u32(DC::COUNT).unwrap(), 2);
    assert_eq!(second.after[2].lamports, POOL_FLOOR);
}

#[test]
fn zero_pay_host_outputs_distinguish_exhausted_caps_from_empty_pool() {
    let _g = begin_parity();
    for (region, day, available, partial, region_capped, day_capped) in [
        (0, 25, 100, false, 0, 0),
        (17, 0, 100, false, 17, 0),
        (17, 25, 0, true, 17, 17),
        (0, 0, 0, false, 0, 0),
    ] {
        let a = accounts(2);
        limits(&a, region, day, available);
        let observed = capture(&a, CLOCK);
        let result = checked(&observed, 0, partial);
        assert_eq!(
            (result.region_capped, result.day_capped),
            (region_capped, day_capped)
        );
        assert_eq!(amount(&a), 0);
        assert_eq!(Ro(&observed.after[3].data).u32(DC::COUNT).unwrap(), 2);
        assert_eq!(Ro(&observed.after[2].data).u64(DP::CLAIMS).unwrap(), 2);
        for i in [5, 7] {
            assert_eq!(observed.after[i].data[wa::wide_arrival_slot::CLAIMED], 1);
        }
    }
}

#[test]
fn created_day_changes_refund_but_settled_does_not() {
    let _g = begin_parity();
    let settled = wa::wide_arrival_slot::FLAG_SETTLED;
    let created = wa::wide_arrival_slot::FLAG_CREATED_DAY;
    for (flags, expected) in [
        (0, 98_852),
        (settled, 98_852),
        (created, 99_152),
        (settled | created, 99_152),
    ] {
        let a = accounts(1);
        edit_slot(&a, |s| s.flags = flags);
        let observed = capture(&a, CLOCK);
        let result = checked(&observed, expected, false);
        assert_eq!(result.per_slot_refunds, vec![expected]);
        assert_eq!(observed.after[5].data[wa::wide_arrival_slot::FLAGS], flags);
    }
}

#[test]
fn every_captured_account_field_mutation_is_refused() {
    let _g = begin_parity();
    let a = accounts(1);
    let observed = capture(&a, CLOCK);
    checked(&observed, 98_852, false);
    for index in 0..observed.after.len() {
        for field in 0..8 {
            let mut changed = observed.clone();
            let account = &mut changed.after[index];
            match field {
                0 => account.key[0] ^= 1,
                1 => account.owner[0] ^= 1,
                2 => account.executable = !account.executable,
                3 => account.rent_epoch ^= 1,
                4 => account.is_signer = !account.is_signer,
                5 => account.is_writable = !account.is_writable,
                6 => account.lamports ^= 1,
                _ => account.data.push(1),
            }
            assert_eq!(changed.verify(), Err(checker::Refusal::PostState { index }));
        }
        // Every byte, including evidence, counters, claimed bits and reserved
        // bytes, is part of the exact post-state comparison.
        for offset in 0..observed.after[index].data.len() {
            let mut changed = observed.clone();
            changed.after[index].data[offset] ^= 1;
            assert_eq!(changed.verify(), Err(checker::Refusal::PostState { index }));
        }
    }
    assert_eq!(
        images(&a),
        observed.after,
        "mutations never touch the host accounts"
    );
}

#[test]
fn every_captured_receipt_byte_mutation_is_refused() {
    let _g = begin_parity();
    let a = accounts(1);
    let observed = capture(&a, CLOCK);
    checked(&observed, 98_852, false);
    for offset in 0..observed.prefix.len() {
        let mut changed = observed.clone();
        changed.prefix[offset] ^= 1;
        assert_eq!(changed.verify(), Err(checker::Refusal::Receipt));
    }
    for offset in 0..observed.body.len() {
        let mut changed = observed.clone();
        changed.body[offset] ^= 1;
        assert_eq!(changed.verify(), Err(checker::Refusal::Receipt));
    }
    for suffix in [false, true] {
        let mut changed = observed.clone();
        if suffix {
            changed.body.push(0);
        } else {
            changed.body.pop();
        }
        assert_eq!(changed.verify(), Err(checker::Refusal::Receipt));
    }
}

#[test]
fn ineligible_dispatches_and_checker_refuse_before_effects_or_receipt() {
    let _g = begin_parity();
    for (case, code, reason) in [
        (0, crate::FrontierError::WindowClosed, "claim grace closed"),
        (1, crate::FrontierError::NotEligible, "not late enough"),
        (2, crate::FrontierError::NotEligible, "zero eligible refund"),
    ] {
        let a = accounts(1);
        let mut clock = CLOCK;
        match case {
            // The fixture's anchor is genesis + 6000, window 0, grace
            // six bells. The exact deadline is excluded by both paths.
            0 => clock.unix_timestamp = GENESIS + 9600,
            1 => edit_slot(&a, |s| s.ev_slot = 104), // 4 < lateness 5
            _ => edit_slot(&a, |s| s.ev_price = 0),
        }
        crate::prologue::set_test_clock(clock.unix_timestamp, clock.slot);
        assert!(!crate::init::is_absent(&a[3]));
        let instruction = command(1);
        let before = images(&a);
        assert!(CAPTURED.lock().unwrap().is_empty());
        assert_eq!(
            exec(&a, &instruction),
            Err(ProgramError::Custom(code as u32))
        );
        let after = images(&a);
        assert_eq!(after, before, "no rollback helper is involved");
        assert!(CAPTURED.lock().unwrap().is_empty());
        let observed = Observed {
            instruction,
            clock,
            before,
            after,
            // No receipt was emitted. These deliberately empty fields
            // ensure the checker refuses eligibility before receipt decode.
            prefix: Vec::new(),
            body: Vec::new(),
        };
        assert_eq!(
            observed.verify(),
            Err(checker::Refusal::Ineligible { index: 5, reason })
        );
    }
}
