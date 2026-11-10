//! Retained bad-seal evidence, native successful writeback, then the existing
//! private expedition ClaimDefence and CloseArrivalSlot. No seal/key creation.
use super::*;
use crate::layout::{defence_claim as DC, defence_pool as DP};
use frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot;
use frontier_abi::world_index::{
    expedition_retained_failure_event as event3, expedition_retained_failure_ix as ix3,
};

impl Input {
    fn retained(fate: u8, eligible: bool) -> Self {
        let mut f = Self::forfeit(fate);
        // The earlier settlement-only fixture used region 0. The continuous
        // claim path requires the actual production region for this coordinate.
        let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
        let dest = WideProvince::read(f.accounts[4].1.data()).unwrap();
        let region = wr::wide_region(dest.coord);
        let mut pd = f.accounts[4].1.data().to_vec();
        Rw(&mut pd).set_u8(PV2::REGION, region).unwrap();
        f.accounts[4].1.set_data_from_slice(&pd);
        let mut ad = f.accounts[8].1.data().to_vec();
        Rw(&mut ad).set_u8(BA::REGION, region).unwrap();
        f.accounts[8].1.set_data_from_slice(&ad);
        f.accounts[8].0 = Pubkey::new_from_array(ctx.bell_anchor(12, region));
        let fixture = crate::proc::wide::expedition_return::proof::tests::bad_point_fixture();
        f.accounts[6].1 = literal(
            *fixture.a[6].owner,
            fixture.a[6].lamports(),
            &fixture.a[6].try_borrow_data().unwrap(),
        );
        if fate == wa::wide_arrival::FATE_DESTROYED {
            let mut pd = f.accounts[4].1.data().to_vec();
            write_entry(&mut pd, 0, &Entry::FREE).unwrap();
            Rw(&mut pd).set_u8(PV::N_ENTRIES, 0).unwrap();
            f.accounts[4].1.set_data_from_slice(&pd);
            let ri = f.index(ix3::ROSTER);
            let mut rd = f.accounts[ri].1.data().to_vec();
            WideRoster::read(&rd).unwrap().release(&mut rd, 0).unwrap();
            f.accounts[ri].1.set_data_from_slice(&rd);
            let mut cd = f.accounts[5].1.data().to_vec();
            let mut rec = WideArrival::read_at(&cd, POSITION).unwrap().unwrap();
            rec.troops_after = 0;
            rec.write_at(&mut cd, POSITION).unwrap();
            f.accounts[5].1.set_data_from_slice(&cd);
        }
        if eligible {
            let mut sd = f.accounts[0].1.data().to_vec();
            Rw(&mut sd).set_u32(S::DEFENCE_CAP_MILLI, 1000).unwrap();
            Rw(&mut sd).set_u8(S::LATENESS_SLOTS, 5).unwrap();
            f.accounts[0].1.set_data_from_slice(&sd);
            f.edit_slot(|s| {
                s.ev_slot = 82;
                s.ev_price = 1_000_000;
                s.ev_limit = 100_000;
                s.ev_loaded = 100_000;
            });
        }
        f
    }
    fn edit_slot(&mut self, edit: impl FnOnce(&mut WideArrivalSlot)) {
        let ctx = addr::ctx(&self.accounts[0].0.to_bytes(), &PROGRAM);
        let slot = ExpeditionArrivalSlot::read(&ctx, self.accounts[6].1.data()).unwrap();
        let mut common = *slot.common();
        edit(&mut common);
        self.accounts[6].1.set_data_from_slice(
            &ExpeditionArrivalSlot::new(&ctx, common, slot.worn_bps())
                .unwrap()
                .to_bytes(&ctx)
                .unwrap(),
        );
    }
    fn retained_wire(&self) -> [u8; ix3::DRAFT_LEN] {
        ix3::DraftCommand::new(SLOT, self.commit, self.seal)
            .unwrap()
            .to_bytes()
    }
    fn settle_retained(&self) -> Vec<AccountSharedData> {
        self.run_with_data(&self.retained_wire(), |p, a, d| {
            crate::proc::wide::expedition_return::settle_retained_failure_draft(p, a, d)
                .map_err(Into::into)
        })
        .unwrap()
    }
    fn apply(&mut self, out: Vec<AccountSharedData>) {
        for ((_, a), next) in self.accounts.iter_mut().zip(out) {
            *a = next;
        }
    }
}
fn observed_v3(
    f: &Input,
    out: &[AccountSharedData],
    hook: &Hook,
    forfeited: bool,
) -> event3::Receipt {
    let logs = hook.take();
    let log = logs.last().unwrap();
    assert_eq!(log[0], event3::PREFIX);
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let r = event3::Receipt::decode(&ctx, &log[1]).unwrap();
    assert_eq!(log[1].len(), event3::LEN);
    assert!(event::Receipt::decode(&ctx, &log[1]).is_err());
    r.verify_previous(
        &ctx,
        event3::Chain::from_account(f.accounts[1].1.data()).unwrap(),
        event3::Chain::from_account(f.accounts[4].1.data()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        event3::Chain::from_account(out[1].data()).unwrap(),
        r.holding_chain
    );
    assert_eq!(
        event3::Chain::from_account(out[4].data()).unwrap(),
        r.destination_chain
    );
    let snap = |accounts: &[AccountSharedData]| -> Vec<Snapshot> {
        f.roles
            .iter()
            .map(|role| {
                let index = role.index_in_transaction as usize;
                let a = &accounts[index];
                Snapshot {
                    address: f.accounts[index].0.to_bytes(),
                    owner: a.owner().to_bytes(),
                    present: !(a.owner() == &init::SYSTEM && a.data().is_empty()),
                    signer: role.is_signer(),
                    writable: role.is_writable(),
                    lamports: a.lamports(),
                    data: a.data().to_vec(),
                }
            })
            .collect()
    };
    let before = snap(
        &f.accounts
            .iter()
            .map(|(_, a)| a.clone())
            .collect::<Vec<_>>(),
    );
    let after = snap(out);
    assert_eq!(
        r.input,
        event3::manifest(
            &ctx,
            &f.retained_wire(),
            r.now_ts,
            r.now_slot,
            &manifest(&before),
            &[]
        )
        .unwrap()
    );
    assert_eq!(
        r.output,
        event3::manifest(
            &ctx,
            &f.retained_wire(),
            r.now_ts,
            r.now_slot,
            &manifest(&after),
            &[before[1].address, before[4].address]
        )
        .unwrap()
    );
    assert_eq!(r.forfeited, forfeited);
    assert_eq!(
        r.fate,
        WideArrival::read_at(f.accounts[5].1.data(), POSITION)
            .unwrap()
            .unwrap()
            .fate
    );
    assert_eq!(r.seal_code, seal_code::BAD_POINT);
    assert_eq!(r.reward, 37);
    assert_eq!(Ro(out[1].data()).u64(H::ESCROW).unwrap(), 0);
    assert!(
        out[1].data()[H::transit(SLOT as usize)..H::transit(SLOT as usize) + MARKER_LEN]
            .iter()
            .all(|b| *b == 0)
    );
    assert_eq!(out[2].owner(), &init::SYSTEM);
    assert_eq!(out[2].lamports(), 0);
    assert!(out[2].data().is_empty());
    assert_eq!(out[3], f.accounts[3].1);
    if r.slot_retained {
        let mut expected = f.accounts[6].1.data().to_vec();
        expected[wa::wide_arrival_slot::FLAGS] |= wa::wide_arrival_slot::FLAG_SETTLED;
        assert_eq!(out[6].data(), expected);
        assert_eq!(out[6].lamports(), f.accounts[6].1.lamports());
        assert_eq!(r.slot_rent, 0);
    } else {
        assert!(out[6].data().is_empty());
        assert_eq!(out[6].owner(), &init::SYSTEM);
        assert_eq!(out[6].lamports(), 0);
        assert_eq!(r.slot_rent, f.accounts[6].1.lamports());
    }
    assert_eq!(
        out[f.index(ix3::ROSTER)],
        f.accounts[f.index(ix3::ROSTER)].1
    );
    assert_ne!(
        WideClashInputsHdr::read(out[5].data())
            .unwrap()
            .settled_mask
            & (1 << POSITION),
        0
    );
    let total: u128 = f.accounts.iter().map(|(_, a)| a.lamports() as u128).sum();
    assert_eq!(
        out.iter().map(|a| a.lamports() as u128).sum::<u128>(),
        total + 1
    );
    let mut corrupt = log[1].clone();
    corrupt[306] = wa::wide_arrival::FATE_BOUNCED;
    assert!(event3::Receipt::decode(&ctx, &corrupt).is_err());
    let mut corrupt = log[1].clone();
    corrupt[307] ^= 1;
    assert!(event3::Receipt::decode(&ctx, &corrupt).is_err());
    r
}
fn refused_v3(f: &Input, hook: &Hook) {
    assert!(hook.take().is_empty());
    let out = f
        .run_with_data(&f.retained_wire(), |p, a, d| {
            assert!(
                crate::proc::wide::expedition_return::settle_retained_failure_draft(p, a, d)
                    .is_err()
            );
            Ok(())
        })
        .unwrap();
    assert_unchanged(f, &out);
    assert!(hook.take().is_empty());
}
#[test]
fn retained_failure_closes_ineligible_slot_for_all_supported_fates() {
    let hook = Hook::install();
    for fate in [
        wa::wide_arrival::FATE_DESTROYED,
        wa::wide_arrival::FATE_STAYS,
        wa::wide_arrival::FATE_WITHDREW,
    ] {
        let mut f = Input::retained(fate, false);
        let out = f.settle_retained();
        let r = observed_v3(&f, &out, &hook, fate != wa::wide_arrival::FATE_DESTROYED);
        assert!(!r.slot_retained);
        assert!(!r.claim_eligible);
        assert_eq!(
            out[7].lamports(),
            f.accounts[7].1.lamports() + f.accounts[2].1.lamports() + f.accounts[6].1.lamports()
        );
        if fate != wa::wide_arrival::FATE_DESTROYED {
            assert_eq!(read_entry(out[4].data(), 0).unwrap().op, EntryOp::Forfeit);
        }
        f.apply(out);
        refused_v3(&f, &hook);
    }
    // Slot rent may share the reward role. Program-owned payees divert reward
    // but still receive rent, and every duplicate view includes the settled bit.
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    let input_address = f.accounts[5].0.to_bytes();
    f.edit_slot(|s| s.rent_to = input_address);
    f.roles[13] = InstructionAccount::new(5, false, true);
    let out = f.settle_retained();
    let r = observed_v3(&f, &out, &hook, true);
    assert!(r.diverted);
    assert_eq!(r.slot_rent_to, input_address);
    assert_eq!(
        out[5].lamports(),
        f.accounts[5].1.lamports() + f.accounts[6].1.lamports()
    );
    assert_eq!(Ro(out[1].data()).u64(H::POOL_OWED).unwrap(), 37);
    let mut f = Input::retained(wa::wide_arrival::FATE_DESTROYED, true);
    f.edit_slot(|s| s.claimed = true);
    let out = f.settle_retained();
    let r = observed_v3(&f, &out, &hook, false);
    assert!(!r.slot_retained);
    assert!(!r.claim_eligible);
    let f = Input::retained(wa::wide_arrival::FATE_DESTROYED, true);
    let clock = SeasonClock::read(f.accounts[0].1.data()).unwrap();
    let a_ts = Ro(f.accounts[8].1.data()).i64(BA::A).unwrap();
    prologue::set_test_clock(
        clock.reveal_close(12, a_ts) + crate::proc::transit::CLAIM_GRACE_BELLS as i64 * 600,
        100,
    );
    let out = f.settle_retained();
    let r = observed_v3(&f, &out, &hook, false);
    assert!(!r.slot_retained);
    assert!(!r.claim_eligible);
}
#[test]
fn retained_failure_keeps_eligible_evidence_then_claims_and_closes() {
    let hook = Hook::install();
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, true);
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    // All auxiliary accounts exist before settlement; subsequent calls use its
    // real writeback. Preallocated claim avoids all allocation and signing CPI.
    let mut pool = vec![0; DP::SIZE];
    crate::layout::init_header(&mut pool, AccountKind::DefencePool, 11).unwrap();
    Rw(&mut pool)
        .set_u64(DP::PER_BELL_REGION_CAP, u64::MAX)
        .unwrap();
    Rw(&mut pool)
        .set_u64(DP::PER_KEEPER_DAY_CAP, u64::MAX)
        .unwrap();
    let pi = f.accounts.len() as u16;
    f.accounts.push((
        Pubkey::new_from_array(ctx.defence_pool()),
        literal(Pubkey::new_from_array(PROGRAM), 1_000_000_000, &pool),
    ));
    let keeper = f.accounts[f.index(10)].0.to_bytes();
    let mut claim = vec![0; DC::SIZE];
    crate::layout::init_header(&mut claim, AccountKind::DefenceClaim, 11).unwrap();
    Rw(&mut claim).set_arr(DC::BENEFICIARY, &keeper).unwrap();
    let ci = f.accounts.len() as u16;
    let seed = frontier_abi::addr::defence_claim_seed(&frontier_abi::addr::keeper_tag8(&keeper), 0);
    f.accounts.push((
        Pubkey::new_from_array(ctx.of(&seed)),
        literal(Pubkey::new_from_array(PROGRAM), 1_000_000_000, &claim),
    ));
    let si = f.accounts.len() as u16;
    let mut system = literal(
        Pubkey::from_str_const("NativeLoader1111111111111111111111111111111"),
        1,
        &[],
    );
    system.set_executable(true);
    f.accounts.push((init::SYSTEM, system));
    let out = f.settle_retained();
    let r = observed_v3(&f, &out, &hook, true);
    assert!(r.slot_retained && r.claim_eligible);
    f.apply(out);
    let ki = f.index(10) as u16;
    let settlement_roles = f.roles.clone();
    // The retained unclaimed entitlement cannot be prematurely closed.
    f.roles = vec![
        InstructionAccount::new(ki, true, false),
        InstructionAccount::new(0, false, false),
        InstructionAccount::new(6, false, true),
        InstructionAccount::new(7, false, true),
        InstructionAccount::new(8, false, false),
    ];
    let out = f
        .run_with_data(&[], |p, a, _| {
            assert!(crate::proc::wide::expedition_close::close_slot(p, a).is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(&f, &out);
    assert!(hook.take().is_empty());
    f.roles = vec![
        InstructionAccount::new(ki, true, true),
        InstructionAccount::new(0, false, false),
        InstructionAccount::new(pi, false, true),
        InstructionAccount::new(ci, false, true),
        InstructionAccount::new(si, false, false),
        InstructionAccount::new(6, false, true),
        InstructionAccount::new(8, false, false),
    ];
    let before_slot = f.accounts[6].1.data().to_vec();
    let before_keeper = f.accounts[ki as usize].1.lamports();
    let before_pool = f.accounts[pi as usize].1.lamports();
    let out = f
        .run_with_data(&[], |p, a, _| {
            crate::proc::wide::defence_exec::claim_expedition_defence(
                p,
                a,
                &wix::ClaimDefence { day: 0, n: 1 },
            )
            .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(out[ki as usize].lamports(), before_keeper + 98_852);
    assert_eq!(out[pi as usize].lamports(), before_pool - 98_852);
    assert_eq!(
        Ro(out[ci as usize].data()).u64(DC::CLAIMED).unwrap(),
        98_852
    );
    let mut expected = before_slot.clone();
    expected[wa::wide_arrival_slot::CLAIMED] = 1;
    assert_eq!(out[6].data(), expected);
    assert_eq!(out[6].lamports(), f.accounts[6].1.lamports());
    assert_eq!(hook.take().len(), 1);
    f.apply(out);
    let out = f
        .run_with_data(&[], |p, a, _| {
            assert!(crate::proc::wide::defence_exec::claim_expedition_defence(
                p,
                a,
                &wix::ClaimDefence { day: 0, n: 1 }
            )
            .is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(&f, &out);
    assert!(hook.take().is_empty());
    f.roles = vec![
        InstructionAccount::new(ki, true, false),
        InstructionAccount::new(0, false, false),
        InstructionAccount::new(6, false, true),
        InstructionAccount::new(7, false, true),
    ];
    let rent = f.accounts[6].1.lamports();
    let recipient = f.accounts[7].1.lamports();
    let out = f
        .run_with_data(&[], |p, a, _| {
            crate::proc::wide::expedition_close::close_slot(p, a).map_err(Into::into)
        })
        .unwrap();
    assert_eq!(out[7].lamports(), recipient + rent);
    assert_eq!(out[6].lamports(), 0);
    assert_eq!(out[6].owner(), &init::SYSTEM);
    assert!(out[6].data().is_empty());
    assert_eq!(hook.take().len(), 1);
    f.apply(out);
    let out = f
        .run_with_data(&[], |p, a, _| {
            assert!(crate::proc::wide::expedition_close::close_slot(p, a).is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(&f, &out);
    assert!(hook.take().is_empty());
    f.roles = settlement_roles;
    refused_v3(&f, &hook);
}
#[test]
fn retained_failure_missing_recipient_and_late_refusals_preserve_state() {
    let hook = Hook::install();
    let mut f = Input::retained(wa::wide_arrival::FATE_WITHDREW, false);
    f.edit_slot(|s| s.rent_to = [123; 32]);
    let out = f.settle_retained();
    let r = observed_v3(&f, &out, &hook, true);
    assert!(r.slot_retained);
    assert!(!r.claim_eligible);
    assert_eq!(r.slot_rent_to, [123; 32]);
    for fate in [
        wa::wide_arrival::FATE_BOUNCED,
        wa::wide_arrival::FATE_RETREATED,
    ] {
        refused_v3(&Input::retained(fate, false), &hook);
    }
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.accounts[6].1 = literal(init::SYSTEM, 0, &[]);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.edit_slot(|s| s.flags |= wa::wide_arrival_slot::FLAG_SETTLED);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.edit_slot(|s| s.citizen = [55; 32]);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.accounts[6].0 = Pubkey::new_from_array([71; 32]);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.accounts[6].1.set_owner(init::SYSTEM);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.accounts[7].1.set_lamports(u64::MAX);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    let ctx = addr::ctx(&f.accounts[0].0.to_bytes(), &PROGRAM);
    let slot = ExpeditionArrivalSlot::read(&ctx, f.accounts[6].1.data()).unwrap();
    let mut native = vec![0; wa::wide_arrival_slot::SIZE];
    slot.common().write(&mut native).unwrap();
    f.accounts[6].1.set_data_from_slice(&native);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.roles[6] = InstructionAccount::new(6, false, false);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.roles[14] = InstructionAccount::new(6, false, true);
    refused_v3(&f, &hook);
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.commit[0] ^= 1;
    refused_v3(&f, &hook);
    for eligible in [false, true] {
        for balance in [false, true] {
            let f = Input::retained(wa::wide_arrival::FATE_STAYS, eligible);
            let out = f
                .run_with_data(&f.retained_wire(), |p, a, d| {
                    if balance {
                        // Holding/rent recipient balances change even when slot stays.
                        let _guard = a[7].try_borrow_lamports()?;
                        assert!(
                            crate::proc::wide::expedition_return::settle_retained_failure_draft(
                                p, a, d
                            )
                            .is_err()
                        );
                    } else {
                        let _guard = a[6].try_borrow_data()?;
                        assert!(
                            crate::proc::wide::expedition_return::settle_retained_failure_draft(
                                p, a, d
                            )
                            .is_err()
                        );
                    }
                    Ok(())
                })
                .unwrap();
            assert_unchanged(&f, &out);
            assert!(hook.take().is_empty());
        }
    }
    for (fate, v1) in [
        (wa::wide_arrival::FATE_DESTROYED, true),
        (wa::wide_arrival::FATE_STAYS, false),
    ] {
        let f = Input::retained(fate, false);
        let wire = if v1 {
            f.wire().to_vec()
        } else {
            f.forfeit_wire().to_vec()
        };
        let out = f
            .run_with_data(&wire, |p, a, d| {
                let result = if v1 {
                    crate::proc::wide::expedition_return::settle_failure_draft(p, &a[..14], d)
                } else {
                    crate::proc::wide::expedition_return::settle_forfeit_draft(p, a, d)
                };
                assert!(result.is_err());
                Ok(())
            })
            .unwrap();
        assert_unchanged(&f, &out);
        assert!(hook.take().is_empty());
    }
    let f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    let out = f
        .run_with_data(&f.retained_wire(), |p, a, d| {
            assert!(crate::dispatch(p, a, d).is_err());
            assert!(crate::proc::wide::expedition_return::settle_forfeit_draft(p, a, d).is_err());
            Ok(())
        })
        .unwrap();
    assert_unchanged(&f, &out);
    assert!(hook.take().is_empty());
}

/// The outer revision is opt-in host dispatch, not proof of deployment or
/// signed transaction admission. Same fixed bad-point fixture, no new seal.
#[cfg(feature = "expedition-dispatch-experimental")]
#[test]
fn experimental_dispatch_retained_failure_matches_private_writes_and_refuses_bad_flags_versions() {
    use frontier_abi::world_index::expedition_dispatch_ix as outer;
    let hook = Hook::install();
    assert_eq!(crate::PROGRAM_VERSION, outer::PROGRAM_VERSION);
    assert_eq!(outer::PROGRAM_VERSION, 0x4804);
    for eligible in [false, true] {
        let f = Input::retained(wa::wide_arrival::FATE_STAYS, eligible);
        assert_eq!(
            Ro(f.accounts[0].1.data()).u16(S::PROGRAM_VERSION).unwrap(),
            crate::PROGRAM_VERSION
        );
        let wire = outer::encode(outer::Kind::SettleRetainedFailure, &f.retained_wire()).unwrap();
        assert_eq!(&wire[..4], &[wix::TAG_SETTLE_TICKET, 0xff, 2, 11]);
        let expected = f.settle_retained();
        let expected_logs = hook.1.lock().unwrap().clone();
        let receipt = observed_v3(&f, &expected, &hook, true);
        assert_eq!(receipt.slot_retained, eligible);
        assert_eq!(receipt.claim_eligible, eligible);
        let actual = f
            .run_with_data(&wire, |p, a, d| {
                crate::dispatch(p, a, d).map_err(Into::into)
            })
            .unwrap();
        assert_eq!(
            actual, expected,
            "outer dispatch must preserve every account effect"
        );
        assert_eq!(
            hook.take(),
            expected_logs,
            "outer dispatch must preserve the exact receipt and logs"
        );
    }
    let refuse = |f: &Input, bytes: &[u8]| {
        assert!(hook.take().is_empty());
        let out = f
            .run_with_data(bytes, |p, a, d| {
                assert!(crate::dispatch(p, a, d).is_err());
                Ok(()) // actual successful writeback; refusal cannot hide effects
            })
            .unwrap();
        assert_unchanged(f, &out);
        assert!(hook.take().is_empty());
    };
    for role_index in [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13] {
        let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
        let index = f.roles[role_index].index_in_transaction;
        // The SDK requires every repeated role to have identical privileges.
        for role in &mut f.roles {
            if role.index_in_transaction == index {
                *role = InstructionAccount::new(index, role.is_signer(), false);
            }
        }
        let wire = outer::encode(outer::Kind::SettleRetainedFailure, &f.retained_wire()).unwrap();
        refuse(&f, &wire);
    }
    let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    f.roles[9] = InstructionAccount::new(f.roles[9].index_in_transaction, false, true);
    let wire = outer::encode(outer::Kind::SettleRetainedFailure, &f.retained_wire()).unwrap();
    refuse(&f, &wire);
    let f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
    let wire = outer::encode(outer::Kind::SettleRetainedFailure, &f.retained_wire()).unwrap();
    for (offset, value) in [
        (2, 1),
        (2, 3),
        (3, outer::Kind::SettleFailure as u8),
        (outer::HEADER_LEN + 3, 1),
        (outer::HEADER_LEN + 3, 2),
    ] {
        let mut corrupt = wire.clone();
        corrupt[offset] = value;
        refuse(&f, &corrupt);
    }
    for version in [0x4004, 0x4803] {
        let mut f = Input::retained(wa::wide_arrival::FATE_STAYS, false);
        let mut season = f.accounts[0].1.data().to_vec();
        Rw(&mut season)
            .set_u16(S::PROGRAM_VERSION, version)
            .unwrap();
        f.accounts[0].1.set_data_from_slice(&season);
        refuse(&f, &wire);
    }
}
