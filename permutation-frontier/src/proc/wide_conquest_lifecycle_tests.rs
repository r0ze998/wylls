//! Continuous same-account host execution, not public activation or beacon
//! provenance. No intermediate siege reports, capture mirrors or reservations
//! are fabricated. Only the final terminal Season status/time is a fixture;
//! invoking EndSeason itself is outside this regression.
use super::*;
use crate::proc::wide::conquest_exec as declaration_engine;
use crate::proc::wide::conquest_exec::tests as declaration;
use frontier_abi::world_index::event::{WideRecord, WideTarget};

/// Narrow extension of the established stub: public-address-checked allocation
/// of the three lifecycle record sizes, and signed System-wallet transfers.
/// It does not simulate arbitrary instructions, crypto, or transaction rollback.
struct LifecycleStubs {
    season: [u8; 32],
    citizen: [u8; 32],
}
static CPIS: Mutex<Vec<(u32, [u8; 32], u64)>> = Mutex::new(Vec::new());
impl solana_program::program_stubs::SyscallStubs for LifecycleStubs {
    fn sol_log(&self, _: &str) {}
    fn sol_log_data(&self, fields: &[&[u8]]) {
        <Stubs as solana_program::program_stubs::SyscallStubs>::sol_log_data(&Stubs, fields);
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let d = &ix.data;
        let ctx = addr::ctx(&self.season, &PROGRAM);
        let coord = WideCoord::checked(129, 0).unwrap();
        let k = ProvinceKey::new(world_of(&ctx).unwrap(), coord);
        if ix.program_id.to_bytes() != prologue::ids::SYSTEM_PROGRAM || d.len() < 4 {
            return Err(ProgramError::InvalidInstructionData);
        }
        if infos.len() != 2
            || ix.accounts.len() != 2
            || ix.accounts[0].pubkey != *infos[0].key
            || ix.accounts[1].pubkey != *infos[1].key
        {
            return Err(ProgramError::InvalidInstructionData);
        }
        match u32::from_le_bytes(d[..4].try_into().unwrap()) {
            2 => {
                if d.len() != 12
                    || !seeds.is_empty()
                    || infos.len() != 2
                    || !infos[0].is_signer
                    || !ix.accounts[0].is_signer
                    || !ix.accounts[0].is_writable
                    || ix.accounts[1].is_signer
                    || !ix.accounts[1].is_writable
                    || !infos[0].is_writable
                    || !infos[1].is_writable
                    || !init::is_absent(&infos[0])
                    || infos[0].key == infos[1].key
                    || key(&infos[0]) != PAYER
                    || ![
                        wc::conquest_address(&ctx, k),
                        wc::capture_escrow_address(&ctx, &self.citizen),
                    ]
                    .contains(&key(&infos[1]))
                {
                    return Err(ProgramError::InvalidArgument);
                }
                let amount = u64::from_le_bytes(d[4..].try_into().unwrap());
                let from = infos[0]
                    .lamports()
                    .checked_sub(amount)
                    .ok_or(ProgramError::InsufficientFunds)?;
                let to = infos[1]
                    .lamports()
                    .checked_add(amount)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                let mut f = infos[0].try_borrow_mut_lamports()?;
                let mut t = infos[1].try_borrow_mut_lamports()?;
                **f = from;
                **t = to;
                CPIS.lock().unwrap().push((2, key(&infos[1]), amount));
                Ok(())
            }
            9 => {
                if d.len() < 84 || infos.len() != 2 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let n = usize::try_from(u64::from_le_bytes(d[36..44].try_into().unwrap()))
                    .map_err(|_| ProgramError::InvalidInstructionData)?;
                if n > 32 || d.len() != 84 + n {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let base: [u8; 32] = d[4..36].try_into().unwrap();
                let owner: [u8; 32] = d[52 + n..84 + n].try_into().unwrap();
                let space = u64::from_le_bytes(d[44 + n..52 + n].try_into().unwrap());
                let expected = match space as usize {
                    wh::wide_holding::SIZE => wh::holding_seed(coord, 1),
                    wc::CONQUEST_SIZE => wc::conquest_seed(k),
                    wc::CAPTURE_ESCROW_SIZE => wc::capture_escrow_seed(&self.citizen),
                    _ => return Err(ProgramError::InvalidInstructionData),
                };
                if ![
                    wh::wide_holding::SIZE as u64,
                    wc::CONQUEST_SIZE as u64,
                    wc::CAPTURE_ESCROW_SIZE as u64,
                ]
                .contains(&space)
                    || owner != PROGRAM
                    || base != self.season
                    || base != key(&infos[1])
                    || !infos[0].is_writable
                    || ix.accounts[0].is_signer
                    || !ix.accounts[0].is_writable
                    || !ix.accounts[1].is_signer
                    || ix.accounts[1].is_writable
                    || infos[1].owner.to_bytes() != PROGRAM
                    || expected.as_bytes() != &d[44..44 + n]
                    || seeds.len() != 1
                    || seeds[0].len() != 3
                    || seeds[0][0] != crate::addr::SEASON_PREFIX
                    || seeds[0][1] != &SID.to_le_bytes()[..]
                    || seeds[0][2].len() != 1
                    || infos[1].try_borrow_data()?.get(S::BUMP).copied()
                        != seeds[0][2].first().copied()
                    || key(&infos[0])
                        != permutation_rules::hash::sha256(&[&base, &d[44..44 + n], &owner])
                    || !seeds.iter().any(|s| {
                        Pubkey::create_program_address(s, &program())
                            .is_ok_and(|k| k.to_bytes() == base)
                    })
                {
                    return Err(ProgramError::InvalidSeeds);
                }
                if !init::is_absent(&infos[0]) {
                    return Err(ProgramError::AccountAlreadyInitialized);
                }
                infos[0].resize(space as usize)?;
                infos[0].assign(&program());
                CPIS.lock().unwrap().push((9, key(&infos[0]), space));
                Ok(())
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

fn unique_lamports(a: &[AccountInfo]) -> u64 {
    a.iter()
        .enumerate()
        .filter(|(i, ai)| !a[..*i].iter().any(|prior| prior.key == ai.key))
        .map(|(_, ai)| ai.lamports())
        .sum()
}

fn continuous(fresh_sidecars: bool, overprefunded: bool) {
    let _serial = SERIAL.lock().unwrap();
    LOGS.lock().unwrap().clear();
    let mut a = declaration::fixture();
    CPIS.lock().unwrap().clear();
    let _installed = Installed(Some(solana_program::program_stubs::set_syscall_stubs(
        Box::new(LifecycleStubs {
            season: key(&a[2]),
            citizen: key(&a[3]),
        }),
    )));
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let world = world_of(&ctx).unwrap();
    let coord = WideCoord::checked(129, 0).unwrap();
    let k = ProvinceKey::new(world, coord);
    let rent = init::rent(wh::wide_holding::SIZE).unwrap();
    let rt = init::rent(wc::CONQUEST_SIZE).unwrap();
    let re = init::rent(wc::CAPTURE_ESCROW_SIZE).unwrap();
    let table_prefund = if overprefunded { rt + 31 } else { rt / 3 };
    let escrow_prefund = if overprefunded { re + 23 } else { re / 2 };
    let table_balance = if fresh_sidecars {
        rt.max(table_prefund)
    } else {
        rt
    };
    let escrow_rent_balance = if fresh_sidecars {
        re.max(escrow_prefund)
    } else {
        re
    };
    if fresh_sidecars {
        a[9] = declaration::ai(
            key(&a[9]),
            prologue::ids::SYSTEM_PROGRAM,
            vec![],
            table_prefund,
            false,
            true,
        );
        a[10] = declaration::ai(
            key(&a[10]),
            prologue::ids::SYSTEM_PROGRAM,
            vec![],
            escrow_prefund,
            false,
            true,
        );
        assert!(init::is_absent(&a[9]) && init::is_absent(&a[10]));
        assert_eq!(key(&a[9]), wc::conquest_address(&ctx, k));
        assert_eq!(key(&a[10]), wc::capture_escrow_address(&ctx, &key(&a[3])));
    }
    // All preconditions precede the declaration. Subsequent game-state writes
    // come exclusively from the authenticated lifecycle implementations.
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        Rw(&mut pd).set_u32(PV2::SCORE_NEXT_BELL, 10).unwrap();
        Rw(&mut pd)
            .set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1)
            .unwrap();
    }
    let mut js = vec![0; K2::JoinShard.size()];
    assert!(write_header(&mut js, K2::JoinShard, SID));
    // The preexisting source is already the Citizen's one extra Holding.
    Rw(&mut js).set_u32(JS2::EXTRA_HOLDINGS, 1).unwrap();
    let shard = account(ctx.join_shard(0, 0), PROGRAM, js, BIG, false, true);
    let mut all = a.clone();
    all.push(shard.clone());
    let total_before = unique_lamports(&all);
    let season_before = a[2].try_borrow_data().unwrap().to_vec();
    let source_start = chain_of(&a[4].try_borrow_data().unwrap()).unwrap();
    let province_start = chain_of(&a[5].try_borrow_data().unwrap()).unwrap();
    let payer_before = a[1].lamports();
    let declaration_before = declaration_engine::states(&a, &[4, 5]).unwrap();
    declaration::execute(&a).unwrap();
    let declaration_after = declaration_engine::states(&a, &[4, 5]).unwrap();
    let declaration_total = payer_before - a[1].lamports();
    let declaration_receipt = declaration_engine::receipt(
        receipt::DECLARE,
        &wix::DeclareSiege { site: 1, entry: 0 }.to_bytes(),
        GENESIS + 6000,
        10,
        &season_before,
        &WideHostRef::new(k, 0, 1, 1).unwrap().to_bytes(),
        &declaration_before,
        &declaration_after,
        &declaration_total.to_le_bytes(),
    )
    .unwrap();
    assert_eq!(
        a[1].lamports(),
        payer_before
            - if fresh_sidecars {
                rt.saturating_sub(table_prefund) + re.saturating_sub(escrow_prefund) + rent
            } else {
                0
            }
    );
    assert_eq!(a[9].lamports(), table_balance);
    assert_eq!(a[10].lamports(), escrow_rent_balance + rent);
    assert_eq!(
        (a[9].owner.to_bytes(), a[9].data_len()),
        (PROGRAM, wc::CONQUEST_SIZE)
    );
    assert_eq!(
        (a[10].owner.to_bytes(), a[10].data_len()),
        (PROGRAM, wc::CAPTURE_ESCROW_SIZE)
    );
    assert_eq!(unique_lamports(&all), total_before);
    let initial_table = table(&program(), &ctx, SID, k, &a[9]).unwrap();
    let initial_escrow = escrow(&program(), &ctx, SID, world, &a[3], &a[10]).unwrap();
    assert_eq!(initial_table.rent_payer(), PAYER);
    assert_eq!(initial_escrow.rent_payer(), PAYER);
    assert_eq!(initial_escrow.funder(), PAYER);
    assert_eq!(initial_escrow.active_mask(), C::reserved_bit(3));
    refused(&a, || declaration::execute(&a));
    let required = Record::read(&a[5].try_borrow_data().unwrap(), 1)
        .unwrap()
        .required as u32;
    for bell in 10..=10 + required {
        let ra = declaration::resolve_fixture(&a, bell);
        let command = wix::ResolveWithConquest {
            bell,
            beneficiary: PAYER,
        };
        let old = wix::Resolve {
            bell,
            beneficiary: PAYER,
        };
        crate::proc::wide::resolve_inner(&program(), &ra, &old, Some(&command)).unwrap();
        refused(&ra, || {
            crate::proc::wide::resolve_inner(&program(), &ra, &old, Some(&command))
        });
        assert_eq!(a[2].try_borrow_data().unwrap().as_ref(), &season_before[..]);
    }
    let completed = Record::read(&a[5].try_borrow_data().unwrap(), 1).unwrap();
    assert_eq!(completed.kind, CR::KIND_CAPTURE_DUE);
    assert_eq!(completed.bell, 10 + required);
    let mut target = a[8].clone();
    target.is_writable = true;
    let capture = vec![
        a[1].clone(),
        a[2].clone(),
        a[5].clone(),
        a[9].clone(),
        a[3].clone(),
        shard.clone(),
        a[10].clone(),
        target,
        a[4].clone(),
        a[11].clone(),
    ];
    let now = prologue::now().unwrap().ts;
    let source_before = a[4].try_borrow_data().unwrap().to_vec();
    let mut settled = hold::read_holding(&source_before).unwrap();
    hold::settle_tiered(
        &mut settled,
        now,
        hold::terrain_ore(&source_before).unwrap(),
    )
    .unwrap();
    let gold = permutation_rules::frontier::holding::Resource::Gold as usize;
    let arms = permutation_rules::frontier::arms::ARMS as usize;
    let expected_gold = settled.stores[gold].value
        + (FRONTIER_7.siege_stake_gold as i64 * MILLI)
            .min((settled.stores[gold].cap - settled.stores[gold].value).max(0));
    let capture_before = declaration_engine::states(&capture, &[2, 7, 8]).unwrap();
    settle_capture_inner(&program(), &capture, &wix::SettleCapture { site: 1 }).unwrap();
    let capture_after = declaration_engine::states(&capture, &[2, 7, 8]).unwrap();
    let credited_gold = (expected_gold - settled.stores[gold].value) as u64;
    let mut capture_outcomes = Vec::new();
    for n in [
        rent - 17,
        credited_gold,
        FRONTIER_7.siege_stake_gold as u64 * MILLI as u64 - credited_gold,
    ] {
        capture_outcomes.extend_from_slice(&n.to_le_bytes());
    }
    let capture_receipt = declaration_engine::receipt(
        receipt::CAPTURE,
        &wix::SettleCapture { site: 1 }.to_bytes(),
        now,
        SeasonClock::read(&season_before)
            .unwrap()
            .bell_at(now)
            .unwrap(),
        &season_before,
        &[],
        &capture_before,
        &capture_after,
        &capture_outcomes,
    )
    .unwrap();
    refused(&capture, || {
        settle_capture_inner(&program(), &capture, &wix::SettleCapture { site: 1 })
    });
    assert_eq!(a[8].lamports(), rent);
    assert_eq!(
        a[10].lamports(),
        escrow_rent_balance + 17,
        "prefunding remains in the isolated escrow ledger"
    );
    assert_eq!(unique_lamports(&all), total_before);
    let h = WideHolding::read(&a[8].try_borrow_data().unwrap()).unwrap();
    assert_eq!(
        (h.coord, h.site, h.gen, h.slot, h.owner_citizen),
        (coord, 1, 1, 3, key(&a[3]))
    );
    assert_eq!(
        Ro(&a[8].try_borrow_data().unwrap())
            .arr::<32>(H::RENT_PAYER)
            .unwrap(),
        PAYER
    );
    assert_eq!(
        Ro(&a[8].try_borrow_data().unwrap())
            .u32(H::CAPTURED_BELL)
            .unwrap(),
        completed.bell
    );
    let credited = hold::read_holding(&a[4].try_borrow_data().unwrap()).unwrap();
    assert_eq!(credited.stores[gold].value, expected_gold);
    assert_eq!(
        credited.stores[arms].value, settled.stores[arms].value,
        "arms are not refunded"
    );
    let cd = a[3].try_borrow_data().unwrap().to_vec();
    assert_eq!(wh::binding_of(&cd, 2).unwrap(), SlotBinding::Wide);
    assert_eq!(wh::binding_of(&cd, 3).unwrap(), SlotBinding::Wide);
    assert_eq!(cd[C::HOLDINGS_N], 2);
    assert_eq!(wc::wide_reservations(cd[C::SLOTS]).unwrap(), 0);
    assert_eq!(Ro(&cd).u64(C::TICKET_ESCROW).unwrap(), 0);
    assert_eq!(
        Ro(&shard.try_borrow_data().unwrap())
            .u32(JS2::EXTRA_HOLDINGS)
            .unwrap(),
        2
    );
    assert_eq!(
        Ro(&shard.try_borrow_data().unwrap())
            .u32(JS2::CAPTURED_IN)
            .unwrap(),
        1
    );
    let immunity = Record::read(&a[5].try_borrow_data().unwrap(), 1).unwrap();
    assert_eq!(immunity.kind, CR::KIND_NONE);
    assert_eq!(
        immunity.bell,
        completed.bell + 1 + FRONTIER_7.immunity_bells as u32
    );
    assert!(table(&program(), &ctx, SID, k, &a[9])
        .unwrap()
        .entry(1)
        .unwrap()
        .is_none());
    let remaining = escrow(&program(), &ctx, SID, world, &a[3], &a[10]).unwrap();
    assert_eq!(remaining.escrow(), 17);
    assert_eq!(remaining.active_mask(), 0);

    let close_table = vec![a[0].clone(), a[2].clone(), a[9].clone(), a[1].clone()];
    let close_x = wix::CloseConquest { p: 129, q: 0 };
    let close_escrow = vec![
        a[0].clone(),
        a[2].clone(),
        a[3].clone(),
        a[10].clone(),
        a[1].clone(),
        a[1].clone(),
    ];
    refused(&close_table, || {
        close_conquest_inner(&program(), &close_table, &close_x)
    });
    // Terminal eligibility alone is staged; no conquest state is rewritten.
    a[2].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ENDED;
    time(1000 + 432 - 1);
    refused(&close_escrow, || {
        close_capture_escrow_inner(&program(), &close_escrow)
    });
    time(1000 + 432);
    let payer_at_close = a[1].lamports();
    let final_game = snapshot(&[
        a[3].clone(),
        a[4].clone(),
        a[5].clone(),
        a[8].clone(),
        shard,
    ]);
    close_conquest_inner(&program(), &close_table, &close_x).unwrap();
    refused(&close_table, || {
        close_conquest_inner(&program(), &close_table, &close_x)
    });
    close_capture_escrow_inner(&program(), &close_escrow).unwrap();
    refused(&close_escrow, || {
        close_capture_escrow_inner(&program(), &close_escrow)
    });
    refused(&capture, || {
        settle_capture_inner(&program(), &capture, &wix::SettleCapture { site: 1 })
    });
    assert!(init::is_absent(&a[9]) && init::is_absent(&a[10]));
    assert_eq!(
        CPIS.lock()
            .unwrap()
            .iter()
            .filter(|(op, _, _)| *op == 9)
            .count(),
        if fresh_sidecars { 3 } else { 1 }
    );
    assert_eq!(
        CPIS.lock()
            .unwrap()
            .iter()
            .filter(|(op, _, _)| *op == 2)
            .count(),
        if fresh_sidecars {
            if overprefunded {
                1
            } else {
                3
            }
        } else {
            0
        }
    );
    assert_eq!(
        a[1].lamports(),
        payer_at_close + table_balance + escrow_rent_balance + 17
    );
    assert_eq!(unique_lamports(&all), total_before);
    assert_eq!(
        snapshot(&[
            a[3].clone(),
            a[4].clone(),
            a[5].clone(),
            a[8].clone(),
            capture[5].clone()
        ]),
        final_game
    );

    let logs = LOGS.lock().unwrap().clone();
    let bodies: Vec<&[u8]> = logs
        .iter()
        .filter(|(prefix, _)| prefix == wev::WIDE_LOG_PREFIX)
        .map(|(_, b)| b.as_slice())
        .collect();
    let records: Vec<_> = bodies
        .iter()
        .map(|b| WideRecord::decode(b).unwrap())
        .collect();
    let payload = |kind| records.iter().find(|r| r.kind == kind).unwrap().payload;
    assert_eq!(
        payload(WideKind::ConquestDeclared),
        payload(WideKind::ConquestDebited)
    );
    assert_eq!(
        payload(WideKind::ConquestCaptured),
        payload(WideKind::ConquestCredited)
    );
    assert_eq!(payload(WideKind::ConquestDeclared), &declaration_receipt);
    assert_eq!(payload(WideKind::ConquestCaptured), &capture_receipt);
    assert_ne!(
        payload(WideKind::ConquestDeclared),
        payload(WideKind::ConquestCaptured)
    );
    assert_eq!(
        records
            .iter()
            .filter(|r| r.kind == WideKind::ConquestResolved)
            .count(),
        required as usize + 1
    );
    for (target, start, account) in [
        (WideTarget::Province(k), province_start, &a[5]),
        (
            WideTarget::Holding(WideHostRef::new(k, 0, 1, 0).unwrap()),
            source_start,
            &a[4],
        ),
        (
            WideTarget::Holding(WideHostRef::new(k, 1, 1, 0).unwrap()),
            (0, [0; 32]),
            &a[8],
        ),
    ] {
        assert_eq!(
            wev::verify_chain(target, start, bodies.iter().copied()).unwrap(),
            chain_of(&account.try_borrow_data().unwrap()).unwrap()
        );
    }
    let sidecars: Vec<_> = logs
        .iter()
        .filter(|(prefix, _)| prefix == receipt::SIDECAR_LOG_PREFIX)
        .collect();
    assert_eq!(sidecars.len(), 1);
    let closed = receipt::SidecarClose::decode(&sidecars[0].1).unwrap();
    assert_eq!(closed.season, key(&a[2]));
    assert_eq!(closed.citizen, key(&a[3]));
    assert_eq!(closed.receipt.action, receipt::ESCROW_CLOSE);
    assert!(!crate::proc::wide::CONQUEST_LIFECYCLE_ENABLED);
}

#[test]
fn retained_sidecars_run_declare_combat_capture_and_terminal_close_on_same_accounts() {
    continuous(false, false);
}

#[test]
fn absent_prefunded_sidecars_are_created_then_complete_the_same_lifecycle() {
    continuous(true, false);
    continuous(true, true);
}
