//! Real typed account/window/fee/route checks, literal prior-state anchor/log.
//! No oracle submission, signature verification override, allocation or CPI.
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
fn fixture() -> (Vec<AccountInfo<'static>>, wix::Reveal) {
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
    let (origin, _, dest_tile) = route.unwrap();
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
        path: [0; ks::PATH_BYTES],
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    let x = wix::Reveal {
        transit_slot: 0,
        target_i: 0,
        plain: wseal::pack(&plain),
        salt: [0x21; 32],
        ct_hash: [0x32; 32],
        beneficiary: [0xb1; 32],
    };
    let root = wseal::seal_root(&wseal::commit(&x.plain, &x.salt), &x.ct_hash);
    let bridge = OwnedBridgeTransit::new(
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
    )
    .unwrap();
    // Valid synthetic zero-priority/limit Season: min_tip(0, 0, 0) = 2500.
    // Reveal only reads this authenticated prior departure; it never debits it.
    let marker = BridgeMarker::new(
        &ctx,
        bridge.common(),
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
        world: dest.world(),
        coord: dest.coord(),
        wedge: dest.coord().wedge().unwrap(),
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
    let mut anchor = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut anchor, K2::BellAnchor, SID));
    let mut w = Rw(&mut anchor);
    w.set_u32(BA::BELL, 12).unwrap();
    w.set_i64(BA::A, LANDED).unwrap();
    w.set_u64(BA::ROUND, clock.tlock_round(12)).unwrap();
    w.set_u64(BA::SLOT, 76).unwrap();
    let mut log = vec![0; K2::BeaconLog.size()];
    assert!(write_header(&mut log, K2::BeaconLog, SID));
    Rw(&mut log)
        .set_u64(BL::LATEST_ROUND, clock.tlock_round(12))
        .unwrap();
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
            ctx.bell_anchor(12, 0),
            PROGRAM,
            anchor,
            false,
            false,
            1_000_000_000,
        ),
        ai(
            ctx.anchor_archive(0, archive_part_of(12)),
            [0; 32],
            vec![],
            false,
            false,
            0,
        ),
        ai(ctx.beacon_log(0), PROGRAM, log, false, false, 1_000_000_000),
        ai(
            wa::clash_inputs_address(&ctx, dest, 12),
            [0; 32],
            vec![],
            false,
            false,
            0,
        ),
        ai(
            wl::province_address(&ctx, dest.coord()),
            PROGRAM,
            pd,
            false,
            false,
            1_000_000_000,
        ),
        ai(
            wa::arrival_day_address(&ctx, dest, wa::day_of(12)),
            [0; 32],
            vec![],
            false,
            true,
            0,
        ),
    ];
    for i in 0..4 {
        a.push(ai(
            wa::arrival_slot_address(&ctx, dest, 12, 0, i),
            [0; 32],
            vec![],
            false,
            i == 0,
            0,
        ));
    }
    a.push(ai(
        frontier_abi::prologue::ids::INSTRUCTIONS_SYSVAR,
        [0; 32],
        vec![0, 0, 0, 0],
        false,
        false,
        0,
    ));
    a.push(ai([0; 32], [0; 32], vec![], false, false, 0));
    a.push(ai(
        ctx.province(128, 0),
        PROGRAM,
        legacy,
        false,
        false,
        1_000_000_000,
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

#[test]
fn stages_real_boundary_route_and_existing_wide_admission_without_effects() {
    let (a, x) = fixture();
    let before = snapshot(&a);
    let p = Pubkey::new_from_array(PROGRAM);
    let plan = stage(&p, &a, &x).unwrap();
    assert_eq!(plan.slot.citizen, OWNER);
    assert_eq!(plan.slot.host, wseal::unpack(&x.plain).unwrap().host);
    assert_eq!(plan.slot.dep_mass, 200_000);
    assert_eq!(plan.route.raw_secs, 2 * FLAT_HEX_SECS);
    assert_eq!(plan.slot.ev_slot, 77);
    assert_eq!(plan.slot.ev_price, 0);
    assert_eq!(plan.slot.rent_to, key(&a[0]));
    assert!(plan.create_day && plan.create_slot && plan.write_day);
    assert_eq!(plan.payer_debit, plan.rent_day + plan.rent_slot);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    assert_eq!(
        ExpeditionArrivalSlot::read(&ctx, &plan.slot_bytes).unwrap(),
        plan.expedition_slot
    );
    assert_eq!(*plan.expedition_slot.common(), plan.slot);
    assert!(wa::WideArrivalSlot::read(&plan.slot_bytes).is_err());
    assert!(wa::WideArrivalDay::read(&plan.day_bytes).unwrap().has(12));
    assert_eq!(snapshot(&a), before);
    assert_eq!(
        execute(&p, &a, &x),
        Err(FrontierError::NotImplemented.into())
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn exact_commitment_window_latch_privilege_and_evidence_refusals() {
    for case in 0..7 {
        let (mut a, mut x) = fixture();
        let p = Pubkey::new_from_array(PROGRAM);
        stage(&p, &a, &x).unwrap();
        let expected = match case {
            0 => {
                x.salt[0] ^= 1;
                FrontierError::CommitMismatch.into()
            }
            1 => {
                prologue::set_test_clock(LANDED + 1000, 77);
                FrontierError::WindowClosed.into()
            }
            2 => {
                Rw(&mut a[8].try_borrow_mut_data().unwrap())
                    .set_u32(PV::RESOLVED_NEXT, 13)
                    .unwrap();
                FrontierError::LatchClosed.into()
            }
            3 => {
                a[11].is_writable = true;
                BAD_ACCOUNT
            }
            4 => {
                a[9].is_writable = false;
                FrontierError::NeedArrivalDay.into()
            }
            5 => {
                a[14] = ai(key(&a[14]), [0; 32], vec![1], false, false, 0);
                BAD_ACCOUNT
            }
            _ => {
                a[2].try_borrow_mut_data().unwrap()[H::OWNER_CITIZEN] ^= 1;
                BAD_ACCOUNT
            }
        };
        let before = snapshot(&a);
        assert_eq!(stage(&p, &a, &x).err(), Some(expected));
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn tower_wear_is_not_dropped_or_used_to_change_quota_mass() {
    let (a, x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    stage(&p, &a, &x).unwrap();
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let t = OwnedBridgeTransit::from_bytes(&ctx, &a[3].try_borrow_data().unwrap())
        .unwrap()
        .transit();
    let entered = WideTile::of(t.origin).neighbors()[0].unwrap().local();
    let at = frontier_abi::v2::layout::province::structure_entry::at(0);
    a[16].try_borrow_mut_data().unwrap()[at..at + 4].copy_from_slice(&[1, entered, 1, 1]);
    let before = snapshot(&a);
    let plan = stage(&p, &a, &x).unwrap();
    assert!(plan.route.wear_bps > 0);
    assert_eq!(plan.expedition_slot.worn_bps(), plan.route.wear_bps);
    assert_eq!(plan.slot.dep_mass, 200_000);
    assert_eq!(
        ExpeditionArrivalSlot::read(&ctx, &plan.slot_bytes).unwrap(),
        plan.expedition_slot
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn recorded_slot_replay_is_rejected_by_existing_full_identity_quota() {
    let (mut a, x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let plan = stage(&p, &a, &x).unwrap();
    a[10] = ai(
        key(&a[10]),
        PROGRAM,
        plan.slot_bytes,
        false,
        true,
        plan.rent_slot,
    );
    let before = snapshot(&a);
    assert_eq!(
        stage(&p, &a, &x).err(),
        Some(FrontierError::AlreadyDone.into())
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn captured_origin_retains_authenticated_original_citizen() {
    let (a, x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    stage(&p, &a, &x).unwrap();
    {
        let mut hd = a[2].try_borrow_mut_data().unwrap();
        hd[H::GEN] = 2;
        Rw(&mut hd).set_arr(H::OWNER_CITIZEN, &[0xc1; 32]).unwrap();
    }
    let before = snapshot(&a);
    let plan = stage(&p, &a, &x).unwrap();
    assert_eq!(plan.slot.citizen, OWNER);
    assert_eq!(plan.expedition_slot.common().citizen, OWNER);
    assert_eq!(snapshot(&a), before);
}

#[test]
fn ownerless_v1_bridge_and_legacy_host_v1_slot_are_refused() {
    for bridge_case in [true, false] {
        let (mut a, x) = fixture();
        let p = Pubkey::new_from_array(PROGRAM);
        let plan = stage(&p, &a, &x).unwrap();
        let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
        if bridge_case {
            let owned =
                OwnedBridgeTransit::from_bytes(&ctx, &a[3].try_borrow_data().unwrap()).unwrap();
            a[3] = ai(
                key(&a[3]),
                PROGRAM,
                owned.common().to_bytes().to_vec(),
                false,
                false,
                a[3].lamports(),
            );
        } else {
            let mut bytes = vec![0; wa::wide_arrival_slot::SIZE];
            plan.slot.write(&mut bytes).unwrap();
            a[10] = ai(key(&a[10]), PROGRAM, bytes, false, true, plan.rent_slot);
        }
        let before = snapshot(&a);
        assert_eq!(stage(&p, &a, &x).err(), Some(BAD_ACCOUNT));
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn prefunded_absent_slot_and_day_charge_only_shortfall() {
    let (a, x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let base = stage(&p, &a, &x).unwrap();
    **a[9].try_borrow_mut_lamports().unwrap() = base.rent_day - 3;
    **a[10].try_borrow_mut_lamports().unwrap() = base.rent_slot - 7;
    **a[0].try_borrow_mut_lamports().unwrap() = 10;
    let before = snapshot(&a);
    assert_eq!(stage(&p, &a, &x).unwrap().payer_debit, 10);
    assert_eq!(snapshot(&a), before);
}

#[test]
fn existing_day_preserves_bits_rent_and_real_compute_budget_evidence() {
    let (mut a, x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let base = stage(&p, &a, &x).unwrap();
    let mut day = wa::WideArrivalDay::new(SID, base.slot.dest, 0, [0xe8; 32]);
    assert!(day.set(11));
    let mut bytes = vec![0; wa::wide_arrival_day::SIZE];
    day.write(&mut bytes).unwrap();
    a[9] = ai(key(&a[9]), PROGRAM, bytes, false, true, base.rent_day);

    // Literal serialized ComputeBudget instructions, parsed by production
    // evidence::read. This is not a signed or submitted transaction fixture.
    let mut limit = vec![evidence::cb::SET_COMPUTE_UNIT_LIMIT];
    limit.extend_from_slice(&200_000u32.to_le_bytes());
    let mut price = vec![evidence::cb::SET_COMPUTE_UNIT_PRICE];
    price.extend_from_slice(&123u64.to_le_bytes());
    let mut loaded = vec![evidence::cb::SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT];
    loaded.extend_from_slice(&65_536u32.to_le_bytes());
    let mut data = vec![3, 0, 0, 0, 0, 0, 0, 0];
    for (i, instruction) in [limit, price, loaded].iter().enumerate() {
        let offset = data.len() as u16;
        data[2 + 2 * i..4 + 2 * i].copy_from_slice(&offset.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data.extend_from_slice(&frontier_abi::prologue::ids::COMPUTE_BUDGET_PROGRAM);
        data.extend_from_slice(&(instruction.len() as u16).to_le_bytes());
        data.extend_from_slice(instruction);
    }
    data.extend_from_slice(&0u16.to_le_bytes());
    a[14] = ai(key(&a[14]), [0; 32], data, false, false, 0);
    let before = snapshot(&a);
    let plan = stage(&p, &a, &x).unwrap();
    let next = wa::WideArrivalDay::read(&plan.day_bytes).unwrap();
    assert!(next.has(11) && next.has(12));
    assert_eq!(next.rent_to, [0xe8; 32]);
    assert!(!plan.create_day && plan.write_day);
    assert_eq!(plan.payer_debit, plan.rent_slot);
    assert_eq!(
        (plan.slot.ev_price, plan.slot.ev_limit, plan.slot.ev_loaded),
        (123, 200_000, 65_536)
    );
    assert_eq!(snapshot(&a), before);
}

#[test]
fn archived_anchor_and_due_seed_beacon_close_reveal() {
    for archived in [true, false] {
        let (mut a, x) = fixture();
        let p = Pubkey::new_from_array(PROGRAM);
        stage(&p, &a, &x).unwrap();
        let expected = if archived {
            use crate::layout::beacon::anchor_archive as AR;
            a[4] = ai(key(&a[4]), [0; 32], vec![], false, false, 0);
            let mut d = vec![0; K2::AnchorArchive.size()];
            assert!(write_header(&mut d, K2::AnchorArchive, SID));
            Rw(&mut d).set_u32(AR::PART, archive_part_of(12)).unwrap();
            let (at, mask) = AR::bit(AR::TOMBSTONE, 12);
            d[at] |= mask;
            a[5] = ai(key(&a[5]), PROGRAM, d, false, false, 1_000_000_000);
            FrontierError::Archived.into()
        } else {
            let clock = SeasonClock::read(&a[1].try_borrow_data().unwrap()).unwrap();
            let seed = clock.seed_round(12, LANDED);
            let now = clock.round_time(seed);
            assert!(clock.round_time(seed) <= now);
            Rw(&mut a[6].try_borrow_mut_data().unwrap())
                .set_u64(BL::LATEST_ROUND, seed)
                .unwrap();
            prologue::set_test_clock(now, 78);
            // With an honestly due seed the time window is already closed.
            // This does not claim isolated coverage of the later log guard.
            FrontierError::WindowClosed.into()
        };
        let before = snapshot(&a);
        assert_eq!(stage(&p, &a, &x).err(), Some(expected));
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn target_and_original_issuer_shields_keep_existing_rules() {
    for own in [false, true] {
        let (a, x) = fixture();
        let p = Pubkey::new_from_array(PROGRAM);
        stage(&p, &a, &x).unwrap();
        let plain = wseal::unpack(&x.plain).unwrap();
        {
            let mut pd = a[8].try_borrow_mut_data().unwrap();
            pd[PV::SITE_COUNT] = 1;
            pd[PV::SITES] = plain.dest_tile;
            pd[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
            pd[PV::site(0) + SM::FACTION] = 1;
            if !own {
                Rw(&mut pd)
                    .set_u32(PV::site(0) + SM::SHIELD_UNTIL_BELL, 13)
                    .unwrap();
            }
        }
        if own {
            Rw(&mut a[2].try_borrow_mut_data().unwrap())
                .set_i64(H::SHIELD_UNTIL, GENESIS + 12 * 600 + 1)
                .unwrap();
        }
        let before = snapshot(&a);
        assert_eq!(
            stage(&p, &a, &x).err(),
            Some(FrontierError::Shielded.into())
        );
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn real_quota_displacement_preserves_existing_slot_rent_recipient() {
    let (mut a, mut x) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let base = stage(&p, &a, &x).unwrap();
    let mut entries = [None; 4];
    for i in 0..4 {
        let mut slot = base.slot;
        slot.i = i as u8;
        slot.dep_mass = 1000;
        slot.host = WideHostRef::new(slot.dest, 0, 1, i as u32 + 1).unwrap();
        slot.citizen = [0x90 + i as u8; 32];
        slot.rent_to = [0xe0 + i as u8; 32];
        entries[i] = Some(WideSlotEntry {
            host: slot.host,
            citizen: slot.citizen,
            troops: slot.dep_mass,
        });
        let mut bytes = vec![0; wa::wide_arrival_slot::SIZE];
        slot.write(&mut bytes).unwrap();
        a[10 + i] = ai(
            key(&a[10 + i]),
            PROGRAM,
            bytes,
            false,
            false,
            base.rent_slot,
        );
    }
    let target = match wide_admit(
        base.slot.dest,
        12,
        &entries,
        WideSlotEntry {
            host: base.slot.host,
            citizen: OWNER,
            troops: 200_000,
        },
    ) {
        WideSlotDecision::Displace { slot, .. } => slot,
        _ => panic!("stronger incoming host must displace"),
    };
    x.target_i = target;
    a[10 + target as usize].is_writable = true;
    let before = snapshot(&a);
    let next = stage(&p, &a, &x).unwrap();
    assert!(!next.create_slot);
    assert_eq!(next.slot.rent_to, [0xe0 + target; 32]);
    assert_eq!(next.payer_debit, next.rent_day);
    assert_eq!(snapshot(&a), before);
}

fn allocated_producer_fixture() -> (Vec<AccountInfo<'static>>, wix::ExpeditionReveal) {
    let (mut a, old) = fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let base = stage(&p, &a, &old).unwrap();
    let mut entries = [None; 4];
    for i in 0..4 {
        let mut s = base.slot;
        s.i = i as u8;
        s.dep_mass = 1000;
        s.host = WideHostRef::new(s.dest, 0, 1, i as u32 + 1).unwrap();
        s.citizen = [0x90 + i as u8; 32];
        s.rent_to = [0xe0 + i as u8; 32];
        entries[i] = Some(WideSlotEntry {
            host: s.host,
            citizen: s.citizen,
            troops: s.dep_mass,
        });
        let mut bytes = vec![0; wa::wide_arrival_slot::SIZE];
        s.write(&mut bytes).unwrap();
        a[10 + i] = ai(
            key(&a[10 + i]),
            PROGRAM,
            bytes,
            false,
            false,
            base.rent_slot,
        );
    }
    let target_i = match wide_admit(
        base.slot.dest,
        12,
        &entries,
        WideSlotEntry {
            host: base.slot.host,
            citizen: OWNER,
            troops: 200_000,
        },
    ) {
        WideSlotDecision::Displace { slot, .. } => slot,
        _ => panic!("fixture must displace"),
    };
    a[10 + target_i as usize].is_writable = true;
    let mut day = wa::WideArrivalDay::new(SID, base.slot.dest, 0, [0xe8; 32]);
    day.set(11);
    let mut bytes = vec![0; wa::wide_arrival_day::SIZE];
    day.write(&mut bytes).unwrap();
    a[9] = ai(key(&a[9]), PROGRAM, bytes, false, true, base.rent_day);
    (
        a,
        wix::ExpeditionReveal {
            transit_slot: old.transit_slot,
            target_i,
            plain: old.plain,
            salt: old.salt,
            ct_hash: old.ct_hash,
            beneficiary: old.beneficiary,
        },
    )
}

#[test]
fn dedicated_producer_commits_allocated_day_and_slot_once_without_cpi() {
    let (a, x) = allocated_producer_fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let before = snapshot(&a);
    let plan = prepare_producer(&p, &a, &x).unwrap();
    assert!(!plan.staged.create_day && !plan.staged.create_slot);
    assert_eq!(plan.staged.payer_debit, 0);
    assert_eq!(
        producer::Record::decode(&ctx, &plan.body).unwrap(),
        plan.record
    );
    assert_eq!(plan.body.len(), producer::REVEAL_RECORD_LEN);
    execute_producer(&p, &a, &x).unwrap();
    let after = snapshot(&a);
    for i in 0..a.len() {
        if i == 9 {
            assert_eq!(after[i].1, plan.staged.day_bytes);
        } else if i == 10 + x.target_i as usize {
            assert_eq!(after[i].1, plan.staged.slot_bytes);
        } else {
            assert_eq!(after[i], before[i]);
        }
        assert_eq!(after[i].0, before[i].0);
        assert_eq!(after[i].2, before[i].2);
    }
    let day = wa::WideArrivalDay::read(&after[9].1).unwrap();
    assert!(day.has(11) && day.has(12));
    assert_eq!(day.rent_to, [0xe8; 32]);
    assert_eq!(plan.staged.slot.rent_to, [0xe0 + x.target_i; 32]);
    assert_eq!(
        execute_producer(&p, &a, &x),
        Err(FrontierError::AlreadyDone.into())
    );
    assert_eq!(snapshot(&a), after);
}

#[test]
fn producer_preflights_all_write_borrows_before_first_byte() {
    for hold_day in [true, false] {
        let (a, x) = allocated_producer_fixture();
        let p = Pubkey::new_from_array(PROGRAM);
        prepare_producer(&p, &a, &x).unwrap();
        let before = snapshot(&a);
        let borrow = a[if hold_day {
            9
        } else {
            10 + x.target_i as usize
        }]
        .try_borrow_data()
        .unwrap();
        assert_eq!(
            execute_producer(&p, &a, &x),
            Err(solana_program::program_error::ProgramError::AccountBorrowFailed.into())
        );
        drop(borrow);
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn producer_manifest_commits_readonly_anchor_bytes_and_absent_rent_plan() {
    let (a, x) = allocated_producer_fixture();
    let p = Pubkey::new_from_array(PROGRAM);
    let first = prepare_producer(&p, &a, &x).unwrap();
    Rw(&mut a[4].try_borrow_mut_data().unwrap())
        .set_u64(BA::SLOT, 75)
        .unwrap();
    let second = prepare_producer(&p, &a, &x).unwrap();
    assert_ne!(first.record.receipt, second.record.receipt);
    let (a, old) = fixture();
    let x = wix::ExpeditionReveal {
        transit_slot: old.transit_slot,
        target_i: old.target_i,
        plain: old.plain,
        salt: old.salt,
        ct_hash: old.ct_hash,
        beneficiary: old.beneficiary,
    };
    let before = snapshot(&a);
    let plan = prepare_producer(&p, &a, &x).unwrap();
    assert!(plan.staged.create_day && plan.staged.create_slot);
    assert_eq!(
        plan.staged.payer_debit,
        plan.staged.rent_day + plan.staged.rent_slot
    );
    assert_eq!(snapshot(&a), before);
    // Deliberately do not execute: this path needs honest System allocation.
}
