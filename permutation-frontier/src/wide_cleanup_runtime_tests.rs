//! Literal, codec-written records and direct WideClose(3)/(4) dispatch.
//! No lifecycle setup, rollback executor, crypto, exporter or network.
use super::*;

const DAY: u32 = 1;
const BELL: u32 = 10;
const GRACE: u32 = 6;

fn command(what: u8) -> [u8; wix::Close::LEN] {
    wix::Close { what }.to_bytes()
}

fn accounts(what: u8) -> Vec<AccountInfo<'static>> {
    let base = fixture();
    let season = base[2].clone();
    put(
        &mut season.try_borrow_mut_data().unwrap(),
        S::CLASH_CLOSE_GRACE,
        &GRACE.to_le_bytes(),
    );
    let mut province = base[5].clone();
    province.is_writable = false;
    let ctx = crate::addr::ctx(&season.key.to_bytes(), &PROGRAM);
    let h = WideHolding::read(&base[4].try_borrow_data().unwrap()).unwrap();
    let dest = ProvinceKey::new(h.world, h.coord);
    let (key, bytes, resolved_next, now_bell) = if what == wix::CLOSE_WHAT_DAY {
        let mut day = wa::WideArrivalDay::new(SEASON_ID, dest, DAY, ANYONE);
        assert!(day.set(DAY * wa::wide_arrival_day::BELLS));
        let mut bytes = vec![0; wa::wide_arrival_day::SIZE];
        day.write(&mut bytes).unwrap();
        let next = (DAY + 1) * wa::wide_arrival_day::BELLS;
        (wa::arrival_day_address(&ctx, dest, DAY), bytes, next, next)
    } else {
        assert_eq!(what, wix::CLOSE_WHAT_INPUTS);
        let mut hdr = wa::WideClashInputsHdr::new(SEASON_ID, dest, BELL, ANYONE);
        hdr.flags = wa::wide_clash_inputs::FLAG_RESOLVED;
        hdr.n_present = 2;
        hdr.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
        hdr.settled_mask = (1 << 0) | (1 << 23);
        hdr.resolved_ts = BELL * 600;
        let mut bytes = vec![0; wa::wide_clash_inputs::SIZE];
        hdr.write(&mut bytes).unwrap();
        for k in [0, 5, 23] {
            wa::WideArrival {
                host: WideHostRef::new(dest, 0, 2, 1).unwrap(),
                citizen: [0x46; 32],
                dep_mass: 100_000,
                troops: 100,
                stamina: 10_000,
                retreat_bps: 0,
                dealt_bps: 10_000,
                faction: (k / 4) as u8,
                unit: 0,
                tile: 0,
                stance: 0,
                present: k != 5,
                fate: wa::wide_arrival::FATE_DESTROYED,
                troops_after: 0,
            }
            .write_at(&mut bytes, k)
            .unwrap();
        }
        (
            wa::clash_inputs_address(&ctx, dest, BELL),
            bytes,
            BELL + 1,
            BELL + GRACE,
        )
    };
    put(
        &mut province.try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &resolved_next.to_le_bytes(),
    );
    at_bell(now_bell);
    vec![
        wallet(WALLET_B, true, false, 0),
        season,
        province,
        info(leak(key, PROGRAM, bytes, 0, BIG + 37), false, true),
        wallet(ANYONE, false, true, 0),
    ]
}

fn edit_inputs(a: &[AccountInfo<'static>], edit: impl FnOnce(&mut wa::WideClashInputsHdr)) {
    let mut bytes = a[3].try_borrow_mut_data().unwrap();
    let mut hdr = wa::WideClashInputsHdr::read(&bytes).unwrap();
    edit(&mut hdr);
    hdr.write(&mut bytes).unwrap();
}

fn logs() -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    (
        LOGS.lock().unwrap().clone(),
        WIDE_LOGS.lock().unwrap().clone(),
    )
}

fn fail(a: &[AccountInfo<'static>], what: u8) -> ProgramError {
    let before = snapshot(a);
    let before_logs = logs();
    let error = exec(a, &command(what)).unwrap_err();
    assert_eq!(snapshot(a), before);
    assert_eq!(logs(), before_logs);
    error
}

fn assert_closed(a: &[AccountInfo<'static>], what: u8, bell_log: u32) {
    let before = snapshot(a);
    let before_logs = logs();
    let (dest, record_bell, rent_to) = if what == wix::CLOSE_WHAT_DAY {
        let d = wa::WideArrivalDay::read(&before[3].1).unwrap();
        (d.dest, d.day * wa::wide_arrival_day::BELLS, d.rent_to)
    } else {
        let h = wa::WideClashInputsHdr::read(&before[3].1).unwrap();
        (h.dest, h.bell, h.rent_to)
    };
    exec(a, &command(what)).unwrap();
    let mut expected = before.clone();
    expected[3] = (0, vec![], Pubkey::new_from_array(SYSTEM));
    expected[4].0 += before[3].0;
    assert_eq!(snapshot(a), expected);
    assert_eq!(*LOGS.lock().unwrap(), before_logs.0);
    let wide = WIDE_LOGS.lock().unwrap();
    assert_eq!(wide.len(), before_logs.1.len() + 1);
    assert_eq!(&wide[..before_logs.1.len()], &before_logs.1);
    let rec = WideRecord::decode(wide.last().unwrap()).unwrap();
    assert_eq!(rec.kind, WideKind::RecordClosed);
    assert_eq!(rec.bell, bell_log);
    assert_eq!(rec.province(), Some(dest));
    assert_eq!(rec.links, [None, None]);
    assert_eq!(
        rec.payload,
        &wev::record_closed_payload(what, record_bell, 0, 0, &rent_to, before[3].0)
    );
}

#[test]
fn day_waits_for_all_144_bells_then_returns_whole_immutable_rent() {
    let _g = begin();
    let a = accounts(wix::CLOSE_WHAT_DAY);
    let need = (DAY + 1) * wa::wide_arrival_day::BELLS;
    for next in [DAY * wa::wide_arrival_day::BELLS + 1, need - 1] {
        put(
            &mut a[2].try_borrow_mut_data().unwrap(),
            PV::RESOLVED_NEXT,
            &next.to_le_bytes(),
        );
        assert_eq!(
            fail(&a, wix::CLOSE_WHAT_DAY),
            ProgramError::Custom(FrontierError::TooEarly as u32)
        );
    }
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &need.to_le_bytes(),
    );
    assert_closed(&a, wix::CLOSE_WHAT_DAY, need);
    fail(&a, wix::CLOSE_WHAT_DAY);
}

#[test]
fn inputs_require_resolution_every_present_settled_and_exact_grace() {
    let _g = begin();
    let a = accounts(wix::CLOSE_WHAT_INPUTS);
    edit_inputs(&a, |h| h.flags = 0);
    assert_eq!(
        fail(&a, wix::CLOSE_WHAT_INPUTS),
        ProgramError::Custom(FrontierError::InputsOpen as u32)
    );
    edit_inputs(&a, |h| {
        h.flags = wa::wide_clash_inputs::FLAG_RESOLVED;
        h.settled_mask = 1;
    });
    assert_eq!(
        fail(&a, wix::CLOSE_WHAT_INPUTS),
        ProgramError::Custom(FrontierError::InputsOpen as u32)
    );
    edit_inputs(&a, |h| h.settled_mask |= 1 << 23);
    // Position 5 has a valid identity but present=false: no settlement bit is required.
    crate::prologue::set_test_clock(GENESIS + ((BELL + GRACE) * 600) as i64 - 1, 1000);
    assert_eq!(
        fail(&a, wix::CLOSE_WHAT_INPUTS),
        ProgramError::Custom(FrontierError::InputsOpen as u32)
    );
    at_bell(BELL + GRACE);
    assert_closed(&a, wix::CLOSE_WHAT_INPUTS, BELL + GRACE);
    fail(&a, wix::CLOSE_WHAT_INPUTS);
}

#[test]
fn no_arrivals_requires_passed_bell_and_grace_from_bell_end() {
    let _g = begin();
    let a = accounts(wix::CLOSE_WHAT_INPUTS);
    {
        let mut bytes = a[3].try_borrow_mut_data().unwrap();
        let old = wa::WideClashInputsHdr::read(&bytes).unwrap();
        bytes.fill(0);
        let mut h = wa::WideClashInputsHdr::new(old.season_id, old.dest, old.bell, old.rent_to);
        h.flags = wa::wide_clash_inputs::FLAG_NO_ARRIVALS;
        h.write(&mut bytes).unwrap();
    }
    at_bell(BELL + 1 + GRACE);
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &BELL.to_le_bytes(),
    );
    assert_eq!(
        fail(&a, wix::CLOSE_WHAT_INPUTS),
        ProgramError::Custom(FrontierError::InputsOpen as u32)
    );
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &(BELL + 1).to_le_bytes(),
    );
    crate::prologue::set_test_clock(GENESIS + ((BELL + 1 + GRACE) * 600) as i64 - 1, 1000);
    assert_eq!(
        fail(&a, wix::CLOSE_WHAT_INPUTS),
        ProgramError::Custom(FrontierError::InputsOpen as u32)
    );
    at_bell(BELL + 1 + GRACE);
    assert_closed(&a, wix::CLOSE_WHAT_INPUTS, BELL + 1 + GRACE);
}

#[test]
fn wrong_recipient_canonical_addresses_and_season_refuse_before_effects() {
    let _g = begin();
    for what in [wix::CLOSE_WHAT_DAY, wix::CLOSE_WHAT_INPUTS] {
        for case in 0..4 {
            let mut a = accounts(what);
            let expected = match case {
                0 => {
                    a[4] = wallet(WALLET_B, false, true, 0);
                    FrontierError::BadAddress
                }
                1 => {
                    let bytes = a[3].try_borrow_data().unwrap().to_vec();
                    a[3] = info(leak([0x71; 32], PROGRAM, bytes, 0, BIG), false, true);
                    FrontierError::BadAddress
                }
                2 => {
                    a[2] = wallet([0x72; 32], false, false, 0);
                    FrontierError::BadAddress
                }
                _ => {
                    put(
                        &mut a[3].try_borrow_mut_data().unwrap(),
                        8,
                        &(SEASON_ID + 1).to_le_bytes(),
                    );
                    FrontierError::BadAccount
                }
            };
            assert_eq!(fail(&a, what), ProgramError::Custom(expected as u32));
        }
    }
}

fn overflow_refuses(what: u8) {
    let a = accounts(what);
    **a[4].try_borrow_mut_lamports().unwrap() = u64::MAX;
    assert_eq!(
        fail(&a, what),
        ProgramError::Custom(FrontierError::Overflow as u32)
    );
}

#[test]
fn day_recipient_overflow_refuses_before_close_effects() {
    let _g = begin();
    overflow_refuses(wix::CLOSE_WHAT_DAY);
}

#[test]
fn inputs_recipient_overflow_refuses_before_close_effects() {
    let _g = begin();
    overflow_refuses(wix::CLOSE_WHAT_INPUTS);
}

fn recipient_borrow_refuses(what: u8) {
    let a = accounts(what);
    let before = snapshot(&a);
    let before_logs = logs();
    let held = a[4].try_borrow_lamports().unwrap();
    let error = exec(&a, &command(what)).unwrap_err();
    drop(held);
    assert_eq!(error, ProgramError::AccountBorrowFailed);
    assert_eq!(snapshot(&a), before);
    assert_eq!(logs(), before_logs);
}

#[test]
fn day_recipient_borrow_refuses_before_close_effects() {
    let _g = begin();
    recipient_borrow_refuses(wix::CLOSE_WHAT_DAY);
}

#[test]
fn inputs_recipient_borrow_refuses_before_close_effects() {
    let _g = begin();
    recipient_borrow_refuses(wix::CLOSE_WHAT_INPUTS);
}

#[test]
fn under_rent_and_all_close_borrow_conflicts_refuse_then_retry() {
    let _g = begin();
    for what in [wix::CLOSE_WHAT_DAY, wix::CLOSE_WHAT_INPUTS] {
        let a = accounts(what);
        **a[3].try_borrow_mut_lamports().unwrap() = 1;
        assert_eq!(
            fail(&a, what),
            ProgramError::Custom(FrontierError::BadAccount as u32)
        );
        for case in 0..5 {
            let a = accounts(what);
            let before = snapshot(&a);
            let before_logs = logs();
            let error = match case {
                0 => {
                    let _held = a[3].try_borrow_data().unwrap();
                    exec(&a, &command(what)).unwrap_err()
                }
                1 => {
                    let _held = a[3].try_borrow_lamports().unwrap();
                    exec(&a, &command(what)).unwrap_err()
                }
                2 => {
                    let _held = a[4].try_borrow_lamports().unwrap();
                    exec(&a, &command(what)).unwrap_err()
                }
                3 => {
                    let _held = a[3].try_borrow_mut_data().unwrap();
                    exec(&a, &command(what)).unwrap_err()
                }
                _ => {
                    let _held = a[4].try_borrow_mut_data().unwrap();
                    exec(&a, &command(what)).unwrap_err()
                }
            };
            assert_eq!(error, ProgramError::AccountBorrowFailed);
            assert_eq!(snapshot(&a), before);
            assert_eq!(logs(), before_logs);
            let bell = if what == wix::CLOSE_WHAT_DAY {
                (DAY + 1) * wa::wide_arrival_day::BELLS
            } else {
                BELL + GRACE
            };
            assert_closed(&a, what, bell);
        }
    }
}

#[test]
fn ended_deadline_and_tombstone_keep_only_canonical_province_requirement() {
    let _g = begin();
    for what in [wix::CLOSE_WHAT_DAY, wix::CLOSE_WHAT_INPUTS] {
        for tombstone in [false, true] {
            let mut a = accounts(what);
            put(
                &mut a[2].try_borrow_mut_data().unwrap(),
                PV::RESOLVED_NEXT,
                &0u32.to_le_bytes(),
            );
            if what == wix::CLOSE_WHAT_INPUTS {
                edit_inputs(&a, |h| h.flags = 0);
            }
            // Aborted is admitted by this close, but does not bypass its case rule.
            a[1].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ABORTED;
            let expected = if what == wix::CLOSE_WHAT_DAY {
                FrontierError::TooEarly
            } else {
                FrontierError::InputsOpen
            };
            assert_eq!(fail(&a, what), ProgramError::Custom(expected as u32));
            let bell_log = if tombstone {
                let mut bytes = a[1].try_borrow_data().unwrap()[..S::TOMBSTONE_SIZE].to_vec();
                bytes[S::STATUS] = S::STATUS_CLOSED;
                a[1] = info(
                    leak(a[1].key.to_bytes(), PROGRAM, bytes, 0, BIG),
                    false,
                    false,
                );
                frontier_abi::log::NO_BELL
            } else {
                {
                    let mut bytes = a[1].try_borrow_mut_data().unwrap();
                    bytes[S::STATUS] = S::STATUS_ENDED;
                    put(&mut bytes, S::END_BELL, &20u32.to_le_bytes());
                }
                let deadline_bell = 20 + 72 * 6;
                crate::prologue::set_test_clock(GENESIS + (deadline_bell * 600) as i64 - 1, 1000);
                assert_eq!(fail(&a, what), ProgramError::Custom(expected as u32));
                at_bell(deadline_bell);
                deadline_bell
            };
            // The province can have closed first, but not at another address.
            let province_key = a[2].key.to_bytes();
            a[2] = wallet([0x73; 32], false, false, 0);
            assert_eq!(
                fail(&a, what),
                ProgramError::Custom(FrontierError::BadAddress as u32)
            );
            a[2] = wallet(province_key, false, false, 0);
            assert_closed(&a, what, bell_log);
        }
    }
}

#[test]
fn zero_payment_program_recipient_and_recipient_data_rent_keep_existing_rules() {
    let _g = begin();
    for what in [wix::CLOSE_WHAT_DAY, wix::CLOSE_WHAT_INPUTS] {
        for case in 0..3 {
            let mut a = accounts(what);
            **a[3].try_borrow_mut_lamports().unwrap() = if case == 0 { 0 } else { 1 };
            if case == 1 {
                // Program recipients do not use the external-account rent floor.
                a[4] = info(leak(ANYONE, PROGRAM, vec![0; 64], 0, 0), false, true);
            } else if case == 2 {
                **a[3].try_borrow_mut_lamports().unwrap() = crate::init::rent(0).unwrap();
                a[4] = info(leak(ANYONE, SYSTEM, vec![0; 64], 0, 0), false, true);
                assert_eq!(
                    fail(&a, what),
                    ProgramError::Custom(FrontierError::BadAccount as u32)
                );
                continue;
            }
            let bell = if what == wix::CLOSE_WHAT_DAY {
                (DAY + 1) * wa::wide_arrival_day::BELLS
            } else {
                BELL + GRACE
            };
            assert_closed(&a, what, bell);
        }
    }
}

#[test]
fn record_cannot_be_its_own_rent_recipient() {
    let _g = begin();
    for what in [wix::CLOSE_WHAT_DAY, wix::CLOSE_WHAT_INPUTS] {
        let mut a = accounts(what);
        let source_key = a[3].key.to_bytes();
        if what == wix::CLOSE_WHAT_DAY {
            let mut bytes = a[3].try_borrow_mut_data().unwrap();
            let mut day = wa::WideArrivalDay::read(&bytes).unwrap();
            day.rent_to = source_key;
            day.write(&mut bytes).unwrap();
        } else {
            edit_inputs(&a, |h| h.rent_to = source_key);
        }
        a[4] = a[3].clone();
        assert_eq!(
            fail(&a, what),
            ProgramError::Custom(FrontierError::BadAccount as u32)
        );
    }
}
