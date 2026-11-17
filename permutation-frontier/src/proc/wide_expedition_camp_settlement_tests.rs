//! Selected unsigned camp-v2 tests. Only the existing audited public Quicknet
//! fixture performs crypto recovery. Prior account snapshots below are synthetic,
//! not evidence of historical Reveal/Gather/Resolve production or SBF rollback.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::world_index::expedition_transport::{
    ExpeditionArrivalSlot, ORIGINAL_OWNER_OFFSET,
};

const PROGRAM: [u8; 32] = [12; 32];
const SLOT: u8 = 2;
const POSITION: usize = wa::wide_clash_inputs::position(2, 0);

fn ai(address: [u8; 32], owner: [u8; 32], data: Vec<u8>) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        false,
        true,
        Box::leak(Box::new(1_000_000_000)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}
struct Fixture {
    a: Vec<AccountInfo<'static>>,
    base: usize,
    commit: [u8; 32],
    seal: [u8; wseal::WIDE_SEAL_LEN],
}
impl Fixture {
    fn new(resident: bool) -> Self {
        let f = super::super::tests::fixture();
        let mut a = f.a;
        for item in &mut a[1..] {
            item.is_writable = true;
        }
        let ctx = addr::ctx(&key(&a[0]), &PROGRAM);
        let mut cd = vec![0; K2::Citizen.size()];
        assert!(write_header(&mut cd, K2::Citizen, 11));
        let owner = if resident {
            assert!(frontier_abi::resident_citizen::mark(&mut cd, &[42; 32]));
            ctx.citizen_by_tag15(&frontier_abi::resident_citizen::resident_tag15(&[42; 32]))
        } else {
            Rw(&mut cd).set_arr(C::WALLET, &[43; 32]).unwrap();
            ctx.citizen(&[43; 32])
        };
        Rw(&mut cd)
            .set_u64(C::CITIZEN_TAG, addr::citizen_tag(&owner))
            .unwrap();
        Rw(&mut cd).set_u64(C::WORKS, 30).unwrap();
        // Synthetic authenticated prior owner snapshots, never a production
        // mutation API. The immutable seal binds the same unchanged full host.
        a[2].try_borrow_mut_data().unwrap()[ORIGINAL_OWNER_OFFSET..].copy_from_slice(&owner);
        Rw(&mut a[1].try_borrow_mut_data().unwrap())
            .set_arr(H::OWNER_CITIZEN, &owner)
            .unwrap();
        {
            let mut data = a[5].try_borrow_mut_data().unwrap();
            let mut ih = WideClashInputsHdr::read(&data).unwrap();
            ih.camp_mask = 1 << POSITION;
            ih.write(&mut data).unwrap();
            let mut arrival = WideArrival::read_at(&data, POSITION).unwrap().unwrap();
            arrival.citizen = owner;
            arrival.fate = wa::wide_arrival::FATE_STAYS;
            arrival.write_at(&mut data, POSITION).unwrap();
        }
        {
            let mut data = a[6].try_borrow_mut_data().unwrap();
            let old = ArrivalSlot::read(&ctx, &data).unwrap();
            let mut slot = *old.common();
            slot.citizen = owner;
            data.copy_from_slice(
                &ExpeditionArrivalSlot::new(&ctx, slot, old.worn_bps())
                    .unwrap()
                    .to_bytes(&ctx)
                    .unwrap(),
            );
        }
        let base = a.len();
        a.push(f.anchor);
        let mut payer = ai([90; 32], [0; 32], vec![]);
        payer.is_signer = true;
        a.push(payer);
        a.push(ai([36; 32], [0; 32], vec![]));
        a.push(ai([35; 32], [0; 32], vec![]));
        a.push(a[7].clone());
        a.push(ai([91; 32], [0; 32], vec![]));
        a.push(ai(owner, PROGRAM, cd));
        Self {
            a,
            base,
            commit: f.commit,
            seal: f.seal,
        }
    }
    fn prepare(&self) -> R<Prepared> {
        prepare_camp_v2(
            &Pubkey::new_from_array(PROGRAM),
            &self.a,
            self.base,
            SLOT,
            &self.commit,
            &self.seal,
        )
    }
    fn state(&self) -> Vec<(Pubkey, u64, Vec<u8>)> {
        self.a
            .iter()
            .map(|a| {
                (
                    *a.owner,
                    a.lamports(),
                    a.try_borrow_data().unwrap().to_vec(),
                )
            })
            .collect()
    }
    fn refuses(&self) {
        let before = self.state();
        assert!(self.prepare().is_err());
        assert_eq!(self.state(), before);
    }
    fn capture(&mut self) {
        let ctx = addr::ctx(&key(&self.a[0]), &PROGRAM);
        let original_owner = key(self.a.last().unwrap());
        let previous = addr::host_id(127, 0, 0, 3, 0).unwrap();
        {
            let mut hd = self.a[1].try_borrow_mut_data().unwrap();
            let off = H::transit(SLOT as usize);
            let marker = BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).unwrap();
            let capture = marker.capture_bond_plan(37, 20).unwrap();
            hd[off..off + MARKER_LEN].copy_from_slice(&capture.marker_after.to_bytes());
            let mut w = Rw(&mut hd);
            w.set_u64(H::ESCROW, capture.escrow_after).unwrap();
            w.set_u8(H::GEN, 2).unwrap();
            w.set_u8(H2::PREV_GEN, 1).unwrap();
            w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
                .unwrap();
            w.set_u64(H2::PREV_OWNER_TAG, addr::citizen_tag(&original_owner))
                .unwrap();
            w.set_u64(H2::PREV_HOME, previous).unwrap();
            w.set_arr(H::OWNER_CITIZEN, &[99; 32]).unwrap();
            w.set_u32(H::HOST_SEQ, 0).unwrap();
        }
        Rw(&mut self.a[3].try_borrow_mut_data().unwrap())
            .set_u8(PV::site(2) + SM::GEN, 2)
            .unwrap();
        let mut hd = vec![0; K2::Holding.size()];
        assert!(write_header(&mut hd, K2::Holding, 11));
        Rw(&mut hd).set_i16(H::P, 127).unwrap();
        Rw(&mut hd).set_u8(H::GEN, 3).unwrap();
        Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL).unwrap();
        self.a.insert(8, ai(ctx.holding(127, 0, 0), PROGRAM, hd));
        self.base = 9;
    }
}

#[test]
fn camp_v2_prepares_wallet_resident_and_captured_original_works() {
    for (resident, captured) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut f = Fixture::new(resident);
        if captured {
            f.capture();
        }
        let before = f.state();
        let prepared = f.prepare().unwrap();
        assert_eq!(f.state(), before);
        let c = f.a.len() - 1;
        assert_eq!(Ro(&prepared.after[c].data).u64(C::WORKS).unwrap(), 40);
        assert_eq!(prepared.after[c].lamports, prepared.before[c].lamports);
        assert_eq!(prepared.after[3].data, prepared.before[3].data);
        if captured {
            assert_eq!(prepared.after[8].data, prepared.before[8].data);
        }
        assert_eq!(prepared.receipts.original[6], 2);
        assert_eq!(prepared.receipts.wide[6], 2);
        let ctx = addr::ctx(&key(&f.a[0]), &PROGRAM);
        assert!(receipt::Record::decode(&ctx, &prepared.receipts.original).is_err());
        assert!(receipt::Record::decode(&ctx, &prepared.receipts.wide).is_err());
        let original =
            receipt::camp_v2::CampRecord::decode(&ctx, &prepared.receipts.original).unwrap();
        let wide = receipt::camp_v2::CampRecord::decode(&ctx, &prepared.receipts.wide).unwrap();
        original.pair(&wide).unwrap();
        assert_eq!(original.record.identity.original_owner, key(&f.a[c]));
        assert_eq!(
            original
                .record
                .original_links
                .iter()
                .map(|l| l.entity)
                .collect::<Vec<_>>(),
            vec![
                frontier_abi::log::EntityKind::Holding,
                frontier_abi::log::EntityKind::Citizen
            ]
        );
        let previous: Vec<_> = [1, c]
            .into_iter()
            .zip(&original.record.original_links)
            .map(|(i, l)| frontier_abi::log::Link {
                entity: l.entity,
                seq: Ro(&prepared.before[i].data).u64(24).unwrap(),
                head: Ro(&prepared.before[i].data).arr(32).unwrap(),
            })
            .collect();
        original.verify_previous(&ctx, &previous, None).unwrap();
        wide.verify_previous(
            &ctx,
            &[],
            Some(wev::WideLink {
                entity: WideEntity::Province,
                seq: 0,
                head: [0; 32],
            }),
        )
        .unwrap();
        // Neither the member contract nor a decoder relabel can consume v2.
        assert!(prepare(
            &Pubkey::new_from_array(PROGRAM),
            &f.a[..c],
            f.base,
            SLOT,
            &f.commit,
            &f.seal
        )
        .is_err());
        assert!(prepare(
            &Pubkey::new_from_array(PROGRAM),
            &f.a,
            f.base,
            SLOT,
            &f.commit,
            &f.seal
        )
        .is_err());
        let mut relabeled = prepared.receipts.original.clone();
        relabeled[6] = 1;
        assert!(receipt::Record::decode(&ctx, &relabeled).is_err());
    }
}

#[test]
fn camp_v2_refuses_wrong_contract_identity_and_incomplete_outcomes() {
    for case in 0..15 {
        let mut f = Fixture::new(false);
        let c = f.a.len() - 1;
        match case {
            0 => {
                f.a.pop();
            }
            1 => f.a.push(f.a[c].clone()),
            2 => f.a[c].is_writable = false,
            3 => {
                Rw(&mut f.a[c].try_borrow_mut_data().unwrap())
                    .set_u64(C::WORKS, u64::MAX)
                    .unwrap();
            }
            4 => {
                Rw(&mut f.a[c].try_borrow_mut_data().unwrap())
                    .set_arr(C::WALLET, &[44; 32])
                    .unwrap();
            }
            5 => {
                f.a[c] = ai(key(&f.a[c]), [0; 32], vec![]);
            }
            6 => {
                f.a[c].try_borrow_mut_data().unwrap()[8..16].copy_from_slice(&12u64.to_le_bytes());
            }
            7 => f.a[c].key = Box::leak(Box::new(Pubkey::new_from_array([99; 32]))),
            8 => f.a[c] = f.a[1].clone(),
            9 | 10 | 11 => {
                let mut data = f.a[5].try_borrow_mut_data().unwrap();
                if case == 9 {
                    let mut ih = WideClashInputsHdr::read(&data).unwrap();
                    ih.camp_mask |= 1;
                    ih.write(&mut data).unwrap();
                } else {
                    let mut r = WideArrival::read_at(&data, POSITION).unwrap().unwrap();
                    if case == 10 {
                        r.fate = wa::wide_arrival::FATE_WITHDREW;
                    } else {
                        r.present = false;
                    }
                    r.write_at(&mut data, POSITION).unwrap();
                }
            }
            12 => {
                f.seal[0] ^= 1;
            }
            13 => {
                // A genuine shared-storage original-Citizen payee is still
                // deliberately unsupported, not treated as a fake alias.
                f.a[f.base + 2] = f.a[c].clone();
                let ctx = addr::ctx(&key(&f.a[0]), &PROGRAM);
                let mut data = f.a[6].try_borrow_mut_data().unwrap();
                let old = ArrivalSlot::read(&ctx, &data).unwrap();
                let mut slot = *old.common();
                slot.beneficiary = key(&f.a[c]);
                data.copy_from_slice(
                    &ExpeditionArrivalSlot::new(&ctx, slot, old.worn_bps())
                        .unwrap()
                        .to_bytes(&ctx)
                        .unwrap(),
                );
            }
            14 => {
                Rw(&mut f.a[c].try_borrow_mut_data().unwrap())
                    .set_u64(C::CITIZEN_TAG, 0)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        f.refuses();
    }
}

#[test]
fn camp_v2_receipt_requires_exact_works_delta_and_unmodified_citizen() {
    let f = Fixture::new(false);
    let prepared = f.prepare().unwrap();
    let ctx = addr::ctx(&key(&f.a[0]), &PROGRAM);
    let record = receipt::camp_v2::CampRecord::decode(&ctx, &prepared.receipts.original).unwrap();
    let mut after = prepared.after.clone();
    for i in [1, 4, f.a.len() - 1] {
        after[i].data[24..64].copy_from_slice(&prepared.before[i].data[24..64]);
    }
    let mut command = vec![2, SLOT];
    command.extend_from_slice(&f.commit);
    command.extend_from_slice(&f.seal);
    let now = prologue::now().unwrap();
    let context = receipt::Context {
        command: &command,
        now_ts: now.ts,
        now_slot: now.slot,
        bell: record.record.bell,
        season: &prepared.before[0].data,
        evidence: &prepared.before[f.base].data,
    };
    let outcomes = receipt::Outcomes {
        fate: 1,
        credited_milli: 0,
        payments: [
            receipt::Payment {
                recipient: [36; 32],
                amount: 7,
                diverted: false,
            },
            receipt::Payment {
                recipient: [35; 32],
                amount: 10,
                diverted: false,
            },
            receipt::Payment {
                recipient: key(&f.a[7]),
                amount: 20,
                diverted: false,
            },
        ],
        pool_owed: 0,
        bridge_rent: prepared.before[2].lamports,
        slot_rent: prepared.before[6].lamports,
        slot_rent_to: key(&f.a[7]),
        slot_retained: false,
    };
    let run = |after: &[Snapshot]| {
        receipt::camp_v2::prepare(
            &ctx,
            record.record.identity,
            &context,
            &manifest(&prepared.before),
            &manifest(after),
            outcomes,
        )
    };
    assert_eq!(run(&after).unwrap(), prepared.receipts);
    let c = after.len() - 1;
    for field in [C::WORKS, C::WALLET, C::RENT_PAYER, 24, 32] {
        let mut wrong = after.clone();
        wrong[c].data[field] ^= 1;
        assert!(run(&wrong).is_err());
    }
    let mut wrong = after;
    wrong[c].lamports += 1;
    assert!(run(&wrong).is_err());
}

#[cfg(feature = "runtime-contract-tests")]
mod runtime {
    use super::*;
    use runtime_contract_support::{
        self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
    };
    use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
    use std::sync::{Arc, Mutex};
    type Logs = Vec<Vec<Vec<u8>>>;
    struct Capture(Arc<Mutex<Logs>>);
    impl SyscallStubs for Capture {
        fn sol_invoke_signed(
            &self,
            _: &solana_program::instruction::Instruction,
            _: &[AccountInfo],
            _: &[&[&[u8]]],
        ) -> Result<(), solana_program::program_error::ProgramError> {
            panic!("CPI is forbidden in this unsigned camp settlement test")
        }
        fn sol_log_data(&self, fields: &[&[u8]]) {
            self.0
                .lock()
                .unwrap()
                .push(fields.iter().map(|s| s.to_vec()).collect());
        }
    }
    struct Hook(Option<Box<dyn SyscallStubs>>);
    impl Drop for Hook {
        fn drop(&mut self) {
            set_syscall_stubs(self.0.take().unwrap());
        }
    }
    #[test]
    fn camp_v2_actual_unsigned_writer_closes_bridge_and_chains_original_citizen() {
        for captured in [false, true] {
            let mut f = Fixture::new(captured);
            if captured {
                f.capture();
            }
            let expected = f.prepare().unwrap();
            let mut accounts: Vec<(Pubkey, AccountSharedData)> = Vec::new();
            let mut roles = Vec::new();
            for a in &f.a {
                let i = accounts
                    .iter()
                    .position(|(k, _)| k == a.key)
                    .unwrap_or_else(|| {
                        let mut data = AccountSharedData::new(a.lamports(), a.data_len(), a.owner);
                        data.set_data_from_slice(&a.try_borrow_data().unwrap());
                        accounts.push((*a.key, data));
                        accounts.len() - 1
                    });
                roles.push(InstructionAccount::new(
                    i as u16,
                    a.is_signer,
                    a.is_writable,
                ));
            }
            let wire =
                frontier_abi::world_index::expedition_settlement_ix::camp_v2::DraftCommand::new(
                    SLOT, f.commit, f.seal,
                )
                .unwrap()
                .to_bytes();
            let prior_total: u128 = accounts.iter().map(|(_, a)| a.lamports() as u128).sum();
            let program_index = accounts.len() as u16;
            let mut program = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
            program.set_executable(true);
            accounts.push((Pubkey::new_from_array(PROGRAM), program));
            let logs = Arc::new(Mutex::new(Vec::new()));
            let _hook = Hook(Some(set_syscall_stubs(Box::new(Capture(logs.clone())))));
            let keys: Vec<_> = accounts.iter().map(|(key, _)| *key).collect();
            let mut overflow = accounts.clone();
            let c = roles.last().unwrap().index_in_transaction as usize;
            let mut bytes = overflow[c].1.data().to_vec();
            Rw(&mut bytes).set_u64(C::WORKS, u64::MAX).unwrap();
            overflow[c].1.set_data_from_slice(&bytes);
            // Catch the real writer's refusal inside the invocation, then let
            // official writeback SUCCEED. No failure disposal/rollback can
            // conceal a partial effect here.
            let unchanged = unsafe {
                rt::run(
                    overflow.clone(),
                    program_index,
                    roles.clone(),
                    wire.to_vec(),
                    |p, a, d| {
                        assert_eq!(
                            super::super::super::settle_camp_draft(p, a, d),
                            Err(OVERFLOW)
                        );
                        Ok(())
                    },
                )
            }
            .unwrap();
            for (actual, (_, before)) in unchanged.iter().zip(&overflow) {
                assert_eq!(actual.owner(), before.owner());
                assert_eq!(actual.lamports(), before.lamports());
                assert_eq!(actual.data(), before.data());
            }
            assert!(logs.lock().unwrap().is_empty());
            // SAFETY: official serializer backing is consumed only inside this
            // closure. No AccountInfo, pointer, guard or clone escapes it.
            let result = unsafe {
                rt::run(
                    accounts,
                    program_index,
                    roles.clone(),
                    wire.to_vec(),
                    |p, a, d| super::super::super::settle_camp_draft(p, a, d).map_err(Into::into),
                )
            }
            .unwrap();
            for (role, staged) in roles.iter().zip(&expected.after) {
                let actual = &result[role.index_in_transaction as usize];
                assert_eq!(actual.owner().to_bytes(), staged.owner);
                assert_eq!(actual.lamports(), staged.lamports);
                assert_eq!(actual.data(), staged.data);
            }
            let actual_total: u128 = result[..program_index as usize]
                .iter()
                .map(|a| a.lamports() as u128)
                .sum();
            assert_eq!(actual_total, prior_total);
            assert!(result[roles[2].index_in_transaction as usize]
                .data()
                .is_empty());
            assert_eq!(
                result[roles[2].index_in_transaction as usize].owner(),
                &init::SYSTEM
            );
            let c = &result[roles.last().unwrap().index_in_transaction as usize];
            assert_eq!(Ro(c.data()).u64(C::WORKS).unwrap(), 40);
            assert_eq!(Ro(c.data()).u64(24).unwrap(), 1);
            assert_eq!(
                core::mem::take(&mut *logs.lock().unwrap()),
                vec![
                    vec![
                        frontier_abi::world_index::expedition_event::PREFIX.to_vec(),
                        expected.receipts.original
                    ],
                    vec![wev::WIDE_LOG_PREFIX.to_vec(), expected.receipts.wide],
                ]
            );
            let replay: Vec<_> = keys.into_iter().zip(result.iter().cloned()).collect();
            // The actual closed bridge/cleared marker/settled inputs reject a
            // replay before effects; successful writeback independently proves
            // all supplied account state stayed unchanged on this refusal.
            let unchanged = unsafe {
                rt::run(
                    replay.clone(),
                    program_index,
                    roles,
                    wire.to_vec(),
                    |p, a, d| {
                        assert!(super::super::super::settle_camp_draft(p, a, d).is_err());
                        Ok(())
                    },
                )
            }
            .unwrap();
            for (actual, (_, before)) in unchanged.iter().zip(&replay) {
                assert_eq!(actual.owner(), before.owner());
                assert_eq!(actual.lamports(), before.lamports());
                assert_eq!(actual.data(), before.data());
            }
            assert!(logs.lock().unwrap().is_empty());
        }
    }
}
