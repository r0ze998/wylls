//! Literal public plaintext/salt, an arbitrary invalid ciphertext hash.
//! Reveal verifies only the commitment; this is not a valid seal fixture.
//! No signing, secret derivation, key generation or crypto override.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::write_header;
use frontier_abi::world_index::expedition::AccountResolver;
const PROGRAM: [u8; 32] = [0x12; 32];
const OWNER: [u8; 32] = [0xa1; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const DEPART: i64 = GENESIS + 6000;
const LANDED: i64 = GENESIS + 7803;

fn ai(
    k: [u8; 32],
    o: [u8; 32],
    d: Vec<u8>,
    signer: bool,
    writable: bool,
    lamports: u64,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(k))),
        signer,
        writable,
        Box::leak(Box::new(lamports)),
        Box::leak(d.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(o))),
        false,
    )
}
fn fixture() -> (Vec<AccountInfo<'static>>, ReverseReveal) {
    prologue::set_test_clock(LANDED + 1, 77);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 0, 1, 0).unwrap())
        .unwrap();
    let mut route = None;
    for local in 0..61 {
        let border = WideTile::of(TileAddress::new(host.key(), local).unwrap());
        let next = border.neighbors()[0].unwrap();
        let prev = border.neighbors()[3].unwrap();
        if next.province_coord().ring() > 128 && prev.province() == host.key() {
            route = Some((prev.address(), border.address(), next.address()));
            break;
        }
    }
    let (dest_tile, _, origin) = route.unwrap();
    let dest = dest_tile.key();
    let plain = WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: 12,
        dest,
        dest_tile: dest_tile.local(),
        stance: 0,
        retreat_bps: 0,
        path_len: 2,
        path: ks::encode_path(&[3, 3]).unwrap().1,
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    let x = ReverseReveal {
        transit_slot: 0,
        target_i: 0,
        plain: wseal::pack(&plain),
        salt: [0x21; 32],
        ct_hash: [0x32; 32],
        beneficiary: [0xb1; 32],
    };
    let root = wseal::seal_root(&wseal::commit(&x.plain, &x.salt), &x.ct_hash);
    let bridge = ReverseTransit::new(
        &ctx,
        0,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            0,
            origin,
            10,
            12,
            DEPART,
            200_000,
            super::super::super::host::DEPART_STAMINA,
            10_000,
            root,
            0,
            0,
            OWNER,
        )
        .unwrap(),
        OWNER,
        dest,
    )
    .unwrap();
    // Valid synthetic zero-priority/limit Season: min_tip(0, 0, 0) = 2500.
    // Reveal only reads this authenticated prior departure; it never debits it.
    let marker = ReverseMarker::new(
        &ctx,
        &bridge,
        2500,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, GENESIS).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_i64(S::DRAND_GENESIS, GENESIS - 100).unwrap();
    w.set_u32(S::DRAND_PERIOD, 3).unwrap();
    w.set_u32(S::REVEAL_WINDOW, 60).unwrap();
    w.set_u32(S::WINDOW_NEXT, 60).unwrap();
    w.set_u32(S::SEED_MARGIN, 60).unwrap();
    let clock = SeasonClock::read(&sd).unwrap();
    assert!(clock.round_time(clock.tlock_round(12)) <= LANDED);
    assert!(clock.round_time(clock.tlock_round(12)) <= LANDED + 1);
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let mut w = Rw(&mut hd);
    w.set_i16(H::P, 128).unwrap();
    w.set_u8(H::GEN, 1).unwrap();
    w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
    w.set_arr(H::OWNER_CITIZEN, &OWNER).unwrap();
    w.set_u32(H::HOST_SEQ, 1).unwrap();
    hd[H::transit(0)..H::transit(0) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    let mut pd = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: SID,
        world: origin.key().world(),
        coord: origin.key().coord(),
        wedge: origin.key().coord().wedge().unwrap(),
        region: 0,
        opened_bell: 1,
        readiness: wl::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [0x51; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut pd)
    .unwrap();
    Rw(&mut pd)
        .set_u64(PV::PASSABLE_MASK, (1u64 << 61) - 1)
        .unwrap();
    let mut legacy = vec![0; K2::Province.size()];
    assert!(write_header(&mut legacy, K2::Province, SID));
    Rw(&mut legacy).set_i16(PV::P, 128).unwrap();
    Rw(&mut legacy)
        .set_u64(PV::PASSABLE_MASK, (1u64 << 61) - 1)
        .unwrap();
    let region = permutation_rules::frontier::geometry::region_of(
        resolver.adapter().coord_of(&dest).unwrap(),
    );
    let mut anchor = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut anchor, K2::BellAnchor, SID));
    let mut w = Rw(&mut anchor);
    w.set_u32(BA::BELL, 12).unwrap();
    w.set_u8(BA::REGION, region).unwrap();
    w.set_i64(BA::A, LANDED).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(12)).unwrap();
    w.set_u64(BA::SLOT, 76).unwrap();
    let mut log = vec![0; K2::BeaconLog.size()];
    assert!(write_header(&mut log, K2::BeaconLog, SID));
    Rw(&mut log)
        .set_u64(BL::LATEST_ROUND, clock.tlock_round(12))
        .unwrap();
    Rw(&mut log).set_u8(BL::REGION, region).unwrap();
    let hk = resolver.holding_address(&host).unwrap();
    let mut a = vec![
        ai([0xd1; 32], [0; 32], vec![], true, true, 1_000_000_000),
        ai(sk, PROGRAM, sd, false, false, 1_000_000_000),
        ai(hk, PROGRAM, hd, false, false, 1_000_000_000),
        ai(
            wm::transit_address(&ctx, &hk, 0),
            PROGRAM,
            bridge.to_bytes().to_vec(),
            false,
            false,
            1_000_000_000,
        ),
        ai(
            ctx.bell_anchor(12, region),
            PROGRAM,
            anchor,
            false,
            false,
            1_000_000_000,
        ),
        ai(
            ctx.anchor_archive(region, archive_part_of(12)),
            [0; 32],
            vec![],
            false,
            false,
            0,
        ),
        ai(
            ctx.beacon_log(region),
            PROGRAM,
            log,
            false,
            false,
            1_000_000_000,
        ),
        ai(
            ctx.clash_inputs(128, 0, 12),
            [0; 32],
            vec![],
            false,
            false,
            0,
        ),
        ai(
            ctx.province(128, 0),
            PROGRAM,
            legacy,
            false,
            false,
            1_000_000_000,
        ),
        ai(ctx.arrival_day(128, 0, 0), [0; 32], vec![], false, true, 0),
    ];
    for i in 0..4 {
        a.push(ai(
            ctx.arrival_slot(128, 0, 12, 0, i),
            [0; 32],
            vec![],
            false,
            i == 0,
            0,
        ));
    }
    a.push(ai(
        frontier_abi::prologue::ids::INSTRUCTIONS_SYSVAR,
        solana_program::sysvar::id().to_bytes(),
        vec![0, 0, 0, 0],
        false,
        false,
        0,
    ));
    a.push(ai(
        [0; 32],
        Pubkey::from_str_const("NativeLoader1111111111111111111111111111111").to_bytes(),
        vec![],
        false,
        false,
        0,
    ));
    (a, x)
}
fn snapshot(a: &[AccountInfo]) -> Vec<(u64, Vec<u8>, Pubkey)> {
    a.iter()
        .map(|a| {
            (
                a.lamports(),
                a.try_borrow_data().unwrap().to_vec(),
                *a.owner,
            )
        })
        .collect()
}

fn existing() -> (Vec<AccountInfo<'static>>, ReverseReveal) {
    let (mut a, mut x) = fixture();
    let initial = stage(&Pubkey::new_from_array(PROGRAM), &a, &x).unwrap();
    let mut dd = initial.day_bytes;
    let (at, mask) = AD::bit(12);
    dd[at] &= !mask;
    a[9] = ai(key(&a[9]), PROGRAM, dd, false, true, 1_000_000_000);
    let mut slots = [None; 4];
    for i in 0..4 {
        let mut bytes = initial.slot_bytes.clone();
        let mut w = Rw(&mut bytes);
        let id = frontier_abi::addr::host_id(1, 0, 0, 1, i as u32).unwrap();
        w.set_u8(AS::I, i as u8).unwrap();
        w.set_u64(AS::HOST_ID, id).unwrap();
        w.set_u64(AS::CITIZEN_TAG, 100 + i as u64).unwrap();
        w.set_u32(AS::DEP_MASS, 10_000 + i as u32).unwrap();
        w.set_arr(AS::RENT_TO, &[0xc1 + i as u8; 32]).unwrap();
        slots[i] = Some(SlotEntry {
            host_id: id,
            citizen: 100 + i as u64,
            troops: 10_000 + i as u32,
        });
        a[10 + i] = ai(key(&a[10 + i]), PROGRAM, bytes, false, false, 1_000_000_000);
    }
    let coord = permutation_rules::frontier::geometry::ProvinceCoord::new(128, 0);
    let me = SlotEntry {
        host_id: Ro(&initial.slot_bytes).u64(AS::HOST_ID).unwrap(),
        citizen: addr::citizen_tag(&OWNER),
        troops: 200_000,
    };
    let SlotDecision::Displace { slot, .. } = admit_arrival(coord, 12, &slots, me) else {
        panic!("displacement")
    };
    x.target_i = slot;
    a[10 + slot as usize].is_writable = true;
    (a, x)
}

#[test]
fn stages_canonical_original_creation_without_new_seal_or_second_quota() {
    let (a, x) = fixture();
    let before = snapshot(&a);
    let p = Pubkey::new_from_array(PROGRAM);
    let plan = prepare_producer(&p, &a, &x).unwrap();
    let s = &plan.staged;
    assert!(s.create_day && s.create_slot && s.write_day);
    assert_eq!(s.slot_bytes.len(), 160);
    assert_eq!(s.day_bytes.len(), 96);
    assert_eq!(s.route.raw_secs, 2 * FLAT_HEX_SECS);
    assert_eq!(s.payer_debit, s.rent_slot + s.rent_day);
    assert_eq!(
        Ro(&s.slot_bytes).u64(AS::HOST_ID).unwrap(),
        frontier_abi::addr::host_id(128, 0, 0, 1, 0).unwrap()
    );
    assert_eq!(Ro(&s.slot_bytes).u32(AS::DEP_MASS).unwrap(), 200_000);
    assert_eq!(snapshot(&a), before);
    assert_eq!(ReverseReveal::decode(&x.to_bytes()), Some(x));
    assert!(wix::ExpeditionReveal::decode(&x.to_bytes()).is_err());
}

#[test]
fn actual_original_slot_displacement_and_day_write_preserve_every_other_account() {
    let (a, x) = existing();
    let p = Pubkey::new_from_array(PROGRAM);
    let before = snapshot(&a);
    let plan = prepare_producer(&p, &a, &x).unwrap();
    assert!(!plan.staged.create_slot && !plan.staged.create_day && plan.staged.write_day);
    assert_eq!(plan.staged.payer_debit, 0);
    execute_producer(&p, &a, &x).unwrap();
    let after = snapshot(&a);
    for i in 0..a.len() {
        if i == 9 {
            assert_eq!(after[i].1, plan.staged.day_bytes);
        } else if i == 10 + x.target_i as usize {
            assert_eq!(after[i].1, plan.staged.slot_bytes);
            assert_eq!(
                &after[i].1[AS::RENT_TO..AS::RENT_TO + 32],
                &before[i].1[AS::RENT_TO..AS::RENT_TO + 32]
            );
        } else {
            assert_eq!(after[i], before[i], "account {i}");
        }
        assert_eq!(after[i].0, before[i].0);
        assert_eq!(after[i].2, before[i].2);
    }
    assert_eq!(
        stage(&p, &a, &x).err(),
        Some(FrontierError::AlreadyDone.into())
    );
}

#[test]
fn commitment_window_latch_pair_quota_and_fee_refuse_before_writes() {
    for case in 0..9 {
        let (mut a, mut x) = existing();
        let p = Pubkey::new_from_array(PROGRAM);
        prepare_producer(&p, &a, &x).unwrap();
        match case {
            0 => x.salt[0] ^= 1,
            1 => prologue::set_test_clock(LANDED + 1000, 77),
            2 => {
                Rw(&mut a[8].try_borrow_mut_data().unwrap())
                    .set_u32(PV::RESOLVED_NEXT, 13)
                    .unwrap();
            }
            3 => a[3].is_writable = true,
            4 => a[2].try_borrow_mut_data().unwrap()[H::transit(0) + T::SEAL_ROOT] ^= 1,
            5 => a[14].try_borrow_mut_data().unwrap()[0] = 1,
            6 => a[9].is_writable = false,
            7 => {
                x.target_i = (x.target_i + 1) % 4;
                for i in 0..4 {
                    a[10 + i].is_writable = i == x.target_i as usize;
                }
            }
            8 => {
                Rw(&mut a[2].try_borrow_mut_data().unwrap())
                    .set_u8(H::GEN, 2)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = snapshot(&a);
        assert!(execute_producer(&p, &a, &x).is_err(), "case {case}");
        assert_eq!(snapshot(&a), before, "case {case}");
    }
}

#[test]
fn full_raw_manifest_commits_original_history_and_owner_beyond_short_tag() {
    let (a, x) = existing();
    let p = Pubkey::new_from_array(PROGRAM);
    let first = prepare_producer(&p, &a, &x).unwrap().receipt;
    // A valid unrelated history byte is read-only but must change the receipt.
    a[2].try_borrow_mut_data().unwrap()[frontier_abi::layout::header::EVENT_HEAD + 17] ^= 1;
    let second = prepare_producer(&p, &a, &x).unwrap().receipt;
    assert_ne!(first.input, second.input);
    assert_ne!(first.output, second.output);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let old = ReverseTransit::from_bytes(&ctx, &a[3].try_borrow_data().unwrap()).unwrap();
    let mut other_owner = OWNER;
    other_owner[31] ^= 1;
    assert_eq!(addr::citizen_tag(&other_owner), addr::citizen_tag(&OWNER));
    let other = ReverseTransit::new(
        &ctx,
        old.slot(),
        old.transit(),
        other_owner,
        old.destination(),
    )
    .unwrap();
    a[3].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&other.to_bytes());
    {
        let mut hd = a[2].try_borrow_mut_data().unwrap();
        Rw(&mut hd).set_arr(H::OWNER_CITIZEN, &other_owner).unwrap();
        let marker = ReverseMarker::new(
            &ctx,
            &other,
            2500,
            T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
        )
        .unwrap();
        hd[H::transit(0)..H::transit(0) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    }
    let third = prepare_producer(&p, &a, &x).unwrap().receipt;
    assert_ne!(second.input, third.input);
    assert_ne!(second.output, third.output);
    let before = snapshot(&a);
    let guard = a[9].try_borrow_data().unwrap();
    assert!(execute_producer(&p, &a, &x).is_err());
    drop(guard);
    assert_eq!(snapshot(&a), before);
}

#[cfg(feature = "system-cpi-tests")]
#[test]
fn real_native_system_cpi_creates_original_day_and_slot_with_exact_prefunds() {
    use runtime_contract_support::{
        self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
    };
    for prefund in [0, 17, 1_000_000_000] {
        let (a, x) = fixture();
        **a[9].try_borrow_mut_lamports().unwrap() = prefund;
        **a[10].try_borrow_mut_lamports().unwrap() = prefund;
        let plan = prepare_producer(&Pubkey::new_from_array(PROGRAM), &a, &x).unwrap();
        let mut accounts = Vec::<(Pubkey, AccountSharedData)>::new();
        let mut roles = Vec::new();
        for ai in &a {
            let mut account = AccountSharedData::new(ai.lamports(), ai.data_len(), ai.owner);
            account.set_data_from_slice(&ai.try_borrow_data().unwrap());
            roles.push(InstructionAccount::new(
                accounts.len() as u16,
                ai.is_signer,
                ai.is_writable,
            ));
            accounts.push((*ai.key, account));
        }
        accounts[15].1.set_owner(Pubkey::from_str_const(
            "NativeLoader1111111111111111111111111111111",
        ));
        accounts[15].1.set_executable(true);
        let mut program = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
        program.set_executable(true);
        let program_i = accounts.len() as u16;
        accounts.push((Pubkey::new_from_array(PROGRAM), program));
        let before = accounts.clone();
        // SAFETY: execute_producer releases every AccountInfo data/lamport
        // borrow before CPI and no borrowed account escapes this callback.
        let output = unsafe {
            rt::system_cpi::run(accounts, program_i, roles, vec![], |p, a, _| {
                execute_producer(p, a, &x).map_err(Into::into)
            })
        }
        .expect("actual native System program and official caller writeback");
        assert_eq!(output.accounts[9].data(), &plan.staged.day_bytes);
        assert_eq!(output.accounts[10].data(), &plan.staged.slot_bytes);
        assert_eq!(output.accounts[9].owner().to_bytes(), PROGRAM);
        assert_eq!(output.accounts[10].owner().to_bytes(), PROGRAM);
        assert_eq!(
            output.accounts[9].lamports(),
            prefund.max(plan.staged.rent_day)
        );
        assert_eq!(
            output.accounts[10].lamports(),
            prefund.max(plan.staged.rent_slot)
        );
        assert_eq!(
            output.accounts[0].lamports(),
            before[0].1.lamports() - plan.staged.payer_debit
        );
        for (i, (_, old)) in before.iter().enumerate() {
            if i != 0 && i != 9 && i != 10 {
                assert_eq!(&output.accounts[i], old, "role {i}");
            }
        }
        assert_eq!(output.logs.len(), 1);
        assert_eq!(output.logs[0][0], wire::PREFIX);
        assert_eq!(output.logs[0][1], plan.receipt.to_bytes());
        assert_eq!(
            output.cpis.len(),
            if prefund < plan.staged.rent_day { 4 } else { 2 }
        );
    }
}

#[cfg(feature = "system-cpi-tests")]
#[test]
fn actual_reveal_output_flows_into_gather_creation_without_account_replacement() {
    use frontier_abi::layout::clash::clash_inputs as CI;
    use runtime_contract_support::{
        self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
    };
    let (a, x) = fixture();
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    // Explicit initial prior state: origin settlement is not executed by this
    // test. All state after this point comes only from native helper writeback.
    let initial = ReverseTransit::from_bytes(&ctx, &a[3].try_borrow_data().unwrap()).unwrap();
    let settled = initial
        .settle_origin(&ctx, false, (180_000, 100, 0))
        .unwrap();
    a[3].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&settled.to_bytes());
    let mut accounts = Vec::<(Pubkey, AccountSharedData)>::new();
    let mut roles = Vec::new();
    for ai in &a {
        let mut account = AccountSharedData::new(ai.lamports(), ai.data_len(), ai.owner);
        account.set_data_from_slice(&ai.try_borrow_data().unwrap());
        roles.push(InstructionAccount::new(
            accounts.len() as u16,
            ai.is_signer,
            ai.is_writable,
        ));
        accounts.push((*ai.key, account));
    }
    accounts[15].1.set_executable(true);
    let mut program = AccountSharedData::new(1, 0, &solana_program::bpf_loader::id());
    program.set_executable(true);
    let program_i = accounts.len() as u16;
    accounts.push((Pubkey::new_from_array(PROGRAM), program));
    let keys: Vec<_> = accounts.iter().map(|(k, _)| *k).collect();
    // SAFETY: both production helpers release all borrows before CPI and no
    // AccountInfo or buffer reference escapes either bounded callback.
    let revealed = unsafe {
        rt::system_cpi::run(accounts, program_i, roles, vec![], |p, a, _| {
            execute_producer(p, a, &x).map_err(Into::into)
        })
    }
    .unwrap();
    assert_eq!(revealed.cpis.len(), 4);
    assert_eq!(revealed.accounts[9].data().len(), 96);
    assert_eq!(revealed.accounts[10].data().len(), 160);
    assert!(revealed.accounts[7].data().is_empty());
    prologue::set_test_clock(LANDED + 1000, 88);
    let gather_roles = [
        (0, true, true),
        (1, false, false),
        (8, false, false),
        (4, false, false),
        (9, false, false),
        (10, false, false),
        (2, false, false),
        (3, false, true),
        (7, false, true),
        (14, false, false),
        (15, false, false),
    ]
    .into_iter()
    .map(|(i, s, w)| InstructionAccount::new(i, s, w))
    .collect::<Vec<_>>();
    let gather_accounts = keys
        .iter()
        .copied()
        .zip(revealed.accounts.iter().cloned())
        .collect();
    let gathered = unsafe {
        rt::system_cpi::run(
            gather_accounts,
            program_i,
            gather_roles.clone(),
            vec![],
            |p, a, _| {
                super::super::expedition_reverse_arrival::execute(p, a, 12, 0).map_err(Into::into)
            },
        )
    }
    .unwrap();
    assert_eq!(gathered.cpis.len(), 2);
    assert_eq!(gathered.accounts[7].owner().to_bytes(), PROGRAM);
    assert_eq!(gathered.accounts[7].data().len(), CI::SIZE);
    assert_eq!(
        Ro(gathered.accounts[7].data())
            .u32(CI::ARRIVALS_MASK)
            .unwrap(),
        1
    );
    let reverse = ReverseTransit::from_bytes(&ctx, gathered.accounts[3].data()).unwrap();
    assert_eq!(reverse.original_owner(), OWNER);
    assert_eq!(reverse.transit().state, MarchState::Gathered);
    assert_eq!(reverse.transit().dest, Some(initial.destination()));
    assert_eq!(reverse.transit().troops_after, 180_000);
    for i in 0..gathered.accounts.len() {
        if ![0, 3, 7].contains(&i) {
            assert_eq!(gathered.accounts[i], revealed.accounts[i], "role {i}");
        }
    }
    let repeat_accounts = keys
        .into_iter()
        .zip(gathered.accounts.iter().cloned())
        .collect();
    let repeated = unsafe {
        rt::system_cpi::run(
            repeat_accounts,
            program_i,
            gather_roles,
            vec![],
            |p, a, _| {
                super::super::expedition_reverse_arrival::execute(p, a, 12, 0).map_err(Into::into)
            },
        )
    }
    .unwrap();
    assert!(repeated.cpis.is_empty());
    assert_eq!(repeated.accounts, gathered.accounts);
}
