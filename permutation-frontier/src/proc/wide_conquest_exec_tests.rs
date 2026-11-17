//! Literal public identities and public PDA arithmetic only. No signing,
//! private-key generation, native-crypto verification, exporters or processes.
//! Private handler tests exercise authenticated effects while public dispatch
//! remains closed; no configuration or argument can bypass that gate.
use super::*;
use alloc::boxed::Box;
use frontier_abi::layout::player::accrual as A;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::presets::{FRONTIER_7, SEASON_CQ_OFFSET};
use frontier_abi::world_index::land::readiness;

const PROGRAM: [u8; 32] = [0x12; 32];
const WALLET: [u8; 32] = [0xa1; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const NOW: i64 = GENESIS + 6_000;

pub(in crate::proc::wide) fn ai(
    address: [u8; 32],
    owner: [u8; 32],
    bytes: Vec<u8>,
    lamports: u64,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    // Runtime-compatible backing also permits this fixture's same canonical
    // target/table/escrow accounts to be allocated or closed by later handlers.
    let len = bytes.len();
    let mut key_bytes = vec![0u8; 36];
    key_bytes[..4].copy_from_slice(&(len as u32).to_le_bytes());
    key_bytes[4..].copy_from_slice(&address);
    let key_bytes = Box::leak(key_bytes.into_boxed_slice());
    // SAFETY: Pubkey alignment is one; the preceding u32 is original_data_len.
    let key = unsafe { &*(key_bytes.as_ptr().add(4) as *const Pubkey) };
    let mut data = vec![0u8; 8 + len.max(wh::wide_holding::SIZE).max(wc::CONQUEST_SIZE)];
    data[..8].copy_from_slice(&(len as u64).to_le_bytes());
    data[8..8 + len].copy_from_slice(&bytes);
    let data = Box::leak(data.into_boxed_slice());
    AccountInfo::new(
        key,
        signer,
        writable,
        Box::leak(Box::new(lamports)),
        &mut data[8..8 + len],
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}

pub(in crate::proc::wide) fn fixture() -> Vec<AccountInfo<'static>> {
    let p = Pubkey::new_from_array(PROGRAM);
    let bump = Pubkey::find_program_address(
        &[
            crate::addr::SEASON_PREFIX,
            &crate::addr::season_seed_id(SID),
        ],
        &p,
    )
    .1;
    let sk = crate::addr::season_pda(SID, bump, &PROGRAM);
    let ctx = crate::addr::ctx(&sk, &PROGRAM);
    let world = world_of(&ctx).unwrap();
    let coord = WideCoord::checked(129, 0).unwrap();
    let pkey = ProvinceKey::new(world, coord);
    let ck = ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&WALLET));
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, GENESIS).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_u16(S::BUCKET_RATE_PER_H, 60).unwrap();
    w.set_u16(S::BUCKET_BURST, 20).unwrap();
    // Clock evidence is fixed before declaration and never silently rewritten
    // between the operation's receipt and subsequent bell receipts.
    w.set_i64(S::DRAND_GENESIS, GENESIS - 100).unwrap();
    w.set_u32(S::DRAND_PERIOD, 3).unwrap();
    w.set_u32(S::REVEAL_WINDOW, 60).unwrap();
    w.set_u32(S::WINDOW_NEXT, 60).unwrap();
    w.set_u32(S::SEED_MARGIN, 60).unwrap();
    w.set_arr(SEASON_CQ_OFFSET, &FRONTIER_7.to_bytes()).unwrap();
    let mut cd = vec![0; C2::SIZE];
    assert!(write_header(&mut cd, K2::Citizen, SID));
    Rw(&mut cd).set_arr(C::WALLET, &WALLET).unwrap();
    Rw(&mut cd).set_u8(C::FLAGS, C::FLAG_JOINED).unwrap();
    Rw(&mut cd).set_u32(C::BUCKET_MILLI, 20_000).unwrap();
    Rw(&mut cd).set_u32(C::TICKET_BELL, C::NO_TICKET).unwrap();
    Rw(&mut cd)
        .set_u64(C::CITIZEN_TAG, frontier_abi::addr::citizen_tag(&ck))
        .unwrap();
    for slot in 1..=3 {
        cd[C2::holding_of_slot(slot) + 5] = C2::EMPTY_GEN;
    }
    wh::bind(&mut cd, 2).unwrap();
    let mut hd = WideHolding::captured_free_city(
        wh::CapturedFreeCity {
            world,
            season_id: SID,
            coord,
            site: 0,
            gen: 1,
            slot: 2,
            owner_citizen: ck,
            tile: 0,
            tier: 1,
            captured_bell: 1,
            current_bell: Some(10),
            now: NOW,
            rent_payer: PAYER,
        },
        &cd,
        &[0; 61],
        &[0; 61],
    )
    .unwrap()
    .to_vec();
    WideHolding::allocate_identity(&mut hd).unwrap();
    Rw(&mut hd).set_u32(H::HOST_SEQ, 1).unwrap();
    for i in 0..permutation_rules::frontier::holding::RESOURCES {
        Rw(&mut hd)
            .set_i64(H::store(i) + A::VALUE, 1_000_000 * MILLI)
            .unwrap();
        Rw(&mut hd)
            .set_i64(H::store(i) + A::CAP, 2_000_000 * MILLI)
            .unwrap();
    }
    let mut pd = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: SID,
        world,
        coord,
        wedge: coord.wedge().unwrap(),
        region: 0,
        opened_bell: 1,
        readiness: readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [0x81; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut pd)
    .unwrap();
    Rw(&mut pd).set_u32(PV::RESOLVED_NEXT, 10).unwrap();
    pd[PV::SITE_COUNT] = 2;
    pd[PV::SITES] = 0;
    pd[PV::SITES + 1] = 1;
    pd[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    pd[PV::site(0) + SM::GEN] = 1;
    pd[PV::site(0) + SM::ORDER] = 2;
    pd[PV::site(1) + SM::STATE] = SM2::STATE_FREE_CITY;
    pd[PV::site(1) + SM::FACTION] = NEUTRAL;
    let roster = WideRoster::new(SID, pkey, PAYER);
    let mut rd = vec![0; wro::wide_roster::SIZE];
    roster.write_header(&mut rd).unwrap();
    let host = WideHostRef::new(pkey, 0, 1, 0).unwrap();
    let alias = roster.claim(&mut rd, 0, &host).unwrap();
    write_entry(
        &mut pd,
        0,
        &Entry {
            id: alias,
            faction: 0,
            unit: 0,
            tile: 1,
            state: E::STATE_ROSTER,
            troops: 100_000,
            from_bell: 1,
            ..Entry::FREE
        },
    )
    .unwrap();
    let table = WideConquest::new(SID, pkey, PAYER).unwrap();
    // A retained wide rent with no active slot, as a prefunded capture may
    // leave it. This is not Citizen.TICKET_ESCROW and invokes no System CPI.
    let binding = CaptureBinding {
        key: pkey,
        site: 1,
        gen: 0,
        declaration_bell: 1,
    };
    let wide_rent = init::rent(wh::wide_holding::SIZE).unwrap();
    let (escrow, _) = WideCaptureEscrow::new(SID, world, ck, PAYER)
        .unwrap()
        .reserve(3, binding, wide_rent, PAYER)
        .unwrap();
    let (escrow, _) = escrow.refund(3, binding, 0).unwrap();
    let province = ai(
        wl::province_address(&ctx, coord),
        PROGRAM,
        pd,
        1_000_000_000,
        false,
        true,
    );
    let mut a = vec![
        ai(WALLET, [0; 32], vec![], 0, true, false),
        ai(PAYER, [0; 32], vec![], 1_000_000_000, true, true),
        ai(sk, PROGRAM, sd, 1_000_000_000, false, false),
        ai(ck, PROGRAM, cd, 1_000_000_000, false, true),
        ai(
            wh::holding_address(&ctx, coord, 0),
            PROGRAM,
            hd,
            1_000_000_000,
            false,
            true,
        ),
        province.clone(),
        ai(
            wro::roster_address(&ctx, pkey),
            PROGRAM,
            rd,
            1_000_000_000,
            false,
            false,
        ),
        province,
        ai(
            wh::holding_address(&ctx, coord, 1),
            [0; 32],
            vec![],
            17,
            false,
            false,
        ),
        ai(
            wc::conquest_address(&ctx, pkey),
            PROGRAM,
            table.to_bytes().to_vec(),
            init::rent(wc::CONQUEST_SIZE).unwrap(),
            false,
            true,
        ),
        ai(
            wc::capture_escrow_address(&ctx, &ck),
            PROGRAM,
            escrow.to_bytes().to_vec(),
            init::rent(wc::CAPTURE_ESCROW_SIZE).unwrap() + wide_rent,
            false,
            true,
        ),
        ai([0; 32], [0; 32], vec![], 0, false, false),
    ];
    a[7].is_writable = false;
    prologue::set_test_clock(NOW, 1_000);
    a
}

fn snapshot(a: &[AccountInfo]) -> Vec<(u64, Vec<u8>, Pubkey)> {
    a.iter()
        .map(|ai| {
            (
                ai.lamports(),
                ai.try_borrow_data().unwrap().to_vec(),
                *ai.owner,
            )
        })
        .collect()
}

/// Already resident on the wide target. This does not simulate or authorize
/// a boundary departure, arrival, or roster admission.
pub(in crate::proc::wide) fn legacy_fixture() -> Vec<AccountInfo<'static>> {
    let mut a = fixture();
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let world = world_of(&ctx).unwrap();
    let coord = WideCoord::checked(1, 0).unwrap();
    let host = WideHostRef::new(ProvinceKey::new(world, coord), 0, 1, 0).unwrap();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    assert_eq!(
        resolver
            .legacy_host_ref(resolver.legacy_host_id(&host).unwrap())
            .unwrap(),
        host
    );
    let mut empty_province = vec![0; K2::Province.size()];
    empty_province[PV::SITE_COUNT] = 1;
    let (_, generation) = cz::home_site(&empty_province, 0, 10).unwrap();
    assert_eq!(generation, 1);
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let mut economy = cz::founded_holding(NOW, addr::day_of(10), 0).unwrap();
    // Mature stocked home, using the original founding codec and layout.
    for s in &mut economy.stores {
        s.value = 1_000_000 * MILLI;
        s.cap = 2_000_000 * MILLI;
    }
    write_founding(
        &mut hd,
        &Founding {
            p: 1,
            q: 0,
            site: 0,
            gen: generation,
            tile: 0,
            owner: key(&a[3]),
            score: 0,
            faction: 0,
            ticket_bell: C::NO_TICKET,
            rent_payer: PAYER,
            final_ts: NOW,
            pool_owed: 0,
            shield_until: NOW,
            terrain_ore: 0,
        },
        &economy,
    )
    .unwrap();
    Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL).unwrap();
    Rw(&mut hd).set_u32(H::HOST_SEQ, 1).unwrap();
    // Continue a nonzero original PS2 chain, never replace it with PSW1.
    crate::layout::set_chain(&mut hd, 7, &[0x6a; 32]).unwrap();
    a[4] = ai(
        resolver.holding_address(&host).unwrap(),
        PROGRAM,
        hd,
        a[4].lamports(),
        false,
        true,
    );
    let mut sp = vec![0; K2::Province.size()];
    assert!(write_header(&mut sp, K2::Province, SID));
    Rw(&mut sp).set_i16(PV::P, 1).unwrap();
    Rw(&mut sp).set_i16(PV::Q, 0).unwrap();
    sp[PV::SITE_COUNT] = 1;
    sp[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    sp[PV::site(0) + SM::GEN] = 1;
    sp[PV::site(0) + SM::ORDER] = 1;
    a[7] = ai(
        resolver.province_address(host.key()).unwrap(),
        PROGRAM,
        sp,
        1_000_000_000,
        false,
        false,
    );
    {
        let mut cd = a[3].try_borrow_mut_data().unwrap();
        wh::unbind(&mut cd, 2).unwrap();
        let o = C2::holding_of_slot(1);
        cd[o..o + 6].copy_from_slice(&[1, 0, 0, 0, 0, 1]);
        cd[C2::HOLDINGS_N] = 1;
        cd[C::FLAGS] |= C::FLAG_HOME_GRANTED | C::FLAG_FIRST_HOLDING_FINAL;
    }
    {
        let mut rd = a[6].try_borrow_mut_data().unwrap();
        let roster = WideRoster::read(&rd).unwrap();
        let old = roster.ref_at(&rd, 0).unwrap().unwrap();
        assert_eq!(roster.release(&mut rd, 0).unwrap(), Some(old));
        let alias = roster.claim(&mut rd, 0, &host).unwrap();
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        let mut e = read_entry(&pd, 0).unwrap();
        e.id = alias;
        write_entry(&mut pd, 0, &e).unwrap();
        roster
            .validate_paired(&rd, &wres::live_ids(&pd).unwrap())
            .unwrap();
    }
    a
}

#[test]
fn legacy_home_declaration_preserves_home_and_refuses_invalid_source_before_effects() {
    let a = legacy_fixture();
    let home = wh::binding_of(&a[3].try_borrow_data().unwrap(), 1).unwrap();
    let source_province = a[7].try_borrow_data().unwrap().to_vec();
    execute(&a).unwrap();
    assert_eq!(a[4].data_len(), K2::Holding.size());
    assert_eq!(
        wh::binding_of(&a[3].try_borrow_data().unwrap(), 1).unwrap(),
        home
    );
    assert_eq!(
        a[7].try_borrow_data().unwrap().as_ref(),
        source_province.as_slice()
    );
    assert_eq!(
        Ro(&a[4].try_borrow_data().unwrap())
            .u32(H::HOST_SEQ)
            .unwrap(),
        1
    );
    assert_eq!(
        crate::layout::chain_of(&a[4].try_borrow_data().unwrap())
            .unwrap()
            .0,
        8
    );
    for case in 0..7 {
        let mut a = legacy_fixture();
        match case {
            0 => a[4].try_borrow_mut_data().unwrap()[H::STATE] = H::STATE_PROVISIONAL,
            1 => Rw(&mut a[4].try_borrow_mut_data().unwrap())
                .set_u32(H::HOST_SEQ, 0)
                .unwrap(),
            2 => a[4].try_borrow_mut_data().unwrap()[H::GEN] = 2,
            3 => a[7].try_borrow_mut_data().unwrap()[PV::site(0) + SM::GEN] = 2,
            4 => a[3].try_borrow_mut_data().unwrap()[C2::holding_of_slot(1) + 5] = 2,
            5 => a[4].try_borrow_mut_data().unwrap()[0] ^= 1,
            _ => {
                let d = a[4].try_borrow_data().unwrap().to_vec();
                a[4] = ai(key(&a[4]), [0x55; 32], d, a[4].lamports(), false, true);
            }
        }
        let before = snapshot(&a);
        assert!(execute(&a).is_err(), "case {case}");
        assert_eq!(snapshot(&a), before, "case {case}");
    }
}

pub(in crate::proc::wide) fn execute(a: &[AccountInfo]) -> R<()> {
    declare_siege_inner(
        &Pubkey::new_from_array(PROGRAM),
        a,
        &wix::DeclareSiege { site: 1, entry: 0 },
        &Auth::Wallet,
    )
}

#[test]
fn authenticated_declaration_debits_stake_and_reserves_only_wide_rent() {
    let a = fixture();
    let before = snapshot(&a);
    execute(&a).unwrap();
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let world = world_of(&ctx).unwrap();
    let pkey = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
    let table = table_at(&a[9], &Pubkey::new_from_array(PROGRAM), &ctx, SID, pkey)
        .unwrap()
        .unwrap();
    let escrow = escrow_at(
        &a[10],
        &Pubkey::new_from_array(PROGRAM),
        &ctx,
        SID,
        world,
        key(&a[3]),
    )
    .unwrap()
    .unwrap();
    let cd = a[3].try_borrow_data().unwrap();
    let pd = a[5].try_borrow_data().unwrap();
    escrow
        .validate_paired(&table, 1, Record::read(&pd, 1).unwrap(), key(&a[3]), &cd)
        .unwrap();
    assert_eq!(table.entry(1).unwrap().unwrap().reserved_slot, 3);
    assert_eq!(Ro(&cd).u64(C::TICKET_ESCROW).unwrap(), 0);
    assert_eq!(Ro(&cd).u8(C2::SIEGES_TODAY).unwrap(), 1);
    assert_eq!(Ro(&cd).u8(C::HOLDINGS_N).unwrap(), 1);
    assert_eq!(escrow.active_mask(), C2::reserved_bit(3));
    let gold = permutation_rules::frontier::holding::Resource::Gold as usize;
    let after_gold = Ro(&a[4].try_borrow_data().unwrap())
        .i64(H::store(gold) + A::VALUE)
        .unwrap();
    assert_eq!(
        Ro(&before[4].1).i64(H::store(gold) + A::VALUE).unwrap() - after_gold,
        FRONTIER_7.siege_stake_gold as i64 * MILLI
    );
    assert_eq!(a[1].lamports(), before[1].0);
    assert_eq!(a[10].lamports(), before[10].0);
    assert_eq!(a[8].lamports(), 17);
    drop(cd);
    drop(pd);
    let done = snapshot(&a);
    assert!(execute(&a).is_err());
    assert_eq!(snapshot(&a), done);
}

#[test]
fn declaration_rejects_auth_capture_lock_marker_and_borrow_conflicts_without_writes() {
    for case in 0..11 {
        let mut a = fixture();
        match case {
            0 => a[0].is_signer = false,
            1 => a[5].try_borrow_mut_data().unwrap()[PV::site(0) + SM::GEN] = 2,
            2 => a[3].try_borrow_mut_data().unwrap()[C2::SLOTS] = wc::wide_reserved_bit(3),
            3 => a[5].try_borrow_mut_data().unwrap()[PV::site(1) + SM::STATE] = SM::STATE_HOLDING,
            4 => a[5].try_borrow_mut_data().unwrap()[PV::site(1) + SM::FACTION] = 0,
            5 => a[4].try_borrow_mut_data().unwrap()[H::STATE] = H::STATE_RELEASED,
            7 => Rw(&mut a[4].try_borrow_mut_data().unwrap())
                .set_u32(H::HOST_SEQ, 0)
                .unwrap(),
            8 => {
                let mut hd = a[4].try_borrow_mut_data().unwrap();
                Rw(&mut hd)
                    .set_u16(
                        wh::wide_holding::HOST_IDENTITY,
                        wh::HOST_IDENTITY_UNALLOCATED,
                    )
                    .unwrap();
                Rw(&mut hd).set_u32(H::HOST_SEQ, 0).unwrap();
            }
            9 => Rw(&mut a[5].try_borrow_mut_data().unwrap())
                .set_u64(frontier_abi::layout::header::EVENT_SEQ, u64::MAX)
                .unwrap(),
            10 => Rw(&mut a[4].try_borrow_mut_data().unwrap())
                .set_u64(frontier_abi::layout::header::EVENT_SEQ, u64::MAX)
                .unwrap(),
            _ => {}
        }
        let before = snapshot(&a);
        let lock = if case == 6 {
            Some(a[9].try_borrow_data().unwrap())
        } else {
            None
        };
        assert!(execute(&a).is_err(), "case {case}");
        drop(lock);
        assert_eq!(snapshot(&a), before, "case {case}");
    }
}

#[test]
fn lead_uses_full_identity_and_refuses_unpaired_or_ineligible_hosts() {
    let a = fixture();
    let mut pd = a[5].try_borrow_data().unwrap().to_vec();
    let mut rd = a[6].try_borrow_data().unwrap().to_vec();
    let roster = WideRoster::read(&rd).unwrap();
    let low = roster.ref_at(&rd, 0).unwrap().unwrap();
    let high = WideHostRef::new(low.key(), low.site(), low.gen(), low.seq() + 1).unwrap();
    let alias = roster.claim(&mut rd, 1, &high).unwrap();
    let mut e = read_entry(&pd, 0).unwrap();
    e.id = alias;
    write_entry(&mut pd, 1, &e).unwrap();
    assert_eq!(lead(&pd, &roster, &rd, 1, 0, 10).unwrap(), Some((0, low)));
    e.troops += 1;
    write_entry(&mut pd, 1, &e).unwrap();
    assert_eq!(lead(&pd, &roster, &rd, 1, 0, 10).unwrap(), Some((1, high)));
    e.from_bell = 11;
    write_entry(&mut pd, 1, &e).unwrap();
    assert_eq!(lead(&pd, &roster, &rd, 1, 0, 10).unwrap(), Some((0, low)));
    e.id ^= 1;
    write_entry(&mut pd, 1, &e).unwrap();
    assert!(lead(&pd, &roster, &rd, 1, 0, 10).is_err());
}

#[test]
fn declaration_accepts_exactly_already_issued_sequences_including_zero() {
    // Both legacy host::muster and wide::muster_as issue HOST_SEQ, then
    // checked-add one. No source counter is incremented by declaration.
    for (sequence, next_unissued, allowed) in [
        (0, 0, false),
        (0, 1, true),
        (1, 1, false),
        (1, 2, true),
        (u32::MAX - 1, u32::MAX, true),
        (u32::MAX, u32::MAX, false),
    ] {
        let a = fixture();
        Rw(&mut a[4].try_borrow_mut_data().unwrap())
            .set_u32(H::HOST_SEQ, next_unissued)
            .unwrap();
        let host = {
            let mut rd = a[6].try_borrow_mut_data().unwrap();
            let roster = WideRoster::read(&rd).unwrap();
            let prior = roster.release(&mut rd, 0).unwrap().unwrap();
            let host = WideHostRef::new(prior.key(), prior.site(), prior.gen(), sequence).unwrap();
            let alias = roster.claim(&mut rd, 0, &host).unwrap();
            let mut pd = a[5].try_borrow_mut_data().unwrap();
            let mut e = read_entry(&pd, 0).unwrap();
            e.id = alias;
            write_entry(&mut pd, 0, &e).unwrap();
            roster
                .validate_paired(&rd, &wres::live_ids(&pd).unwrap())
                .unwrap();
            host
        };
        let before = snapshot(&a);
        let result = execute(&a);
        if allowed {
            result.unwrap();
            assert_eq!(
                Ro(&a[4].try_borrow_data().unwrap())
                    .u32(H::HOST_SEQ)
                    .unwrap(),
                next_unissued
            );
            let table =
                WideConquest::read(&a[9].try_borrow_data().unwrap(), SID, host.key()).unwrap();
            assert_eq!(
                table.entry(1).unwrap().unwrap().source,
                Some(host.holding_ref())
            );
        } else {
            assert_eq!(result, Err(cq(CqError::NotOnHex)));
            assert_eq!(
                snapshot(&a),
                before,
                "unissued sequence {sequence} at count {next_unissued}"
            );
        }
    }
}

#[test]
fn all_new_public_dispatches_remain_closed_without_effects() {
    let a = fixture();
    let before = snapshot(&a);
    let commands = [
        wix::DeclareSiege { site: 1, entry: 0 }.to_bytes().to_vec(),
        wix::SettleSiege { site: 1 }.to_bytes().to_vec(),
        wix::SettleCapture { site: 1 }.to_bytes().to_vec(),
        wix::ResolveWithConquest {
            bell: 10,
            beneficiary: [0x44; 32],
        }
        .to_bytes()
        .to_vec(),
        wix::CloseConquest { p: 129, q: 0 }.to_bytes().to_vec(),
        wix::CloseCaptureEscrow.to_bytes().to_vec(),
    ];
    assert!(!CONQUEST_LIFECYCLE_ENABLED);
    for command in commands {
        assert_eq!(
            crate::dispatch(&Pubkey::new_from_array(PROGRAM), &a, &command),
            Err(FrontierError::NotImplemented.into())
        );
        assert_eq!(snapshot(&a), before);
    }
}

#[test]
fn resident_receipt_context_preserves_outer_generation_and_all_proof_roles() {
    // These literal proof bytes test receipt provenance, not Core ownership.
    // Actual resident authorization remains player_start_as/resident::start.
    let mut a = fixture();
    for i in 0..4u8 {
        a.push(ai(
            [0x61 + i; 32],
            [0x99; 32],
            vec![i, 7, 9],
            123,
            false,
            false,
        ));
    }
    let inner = wix::DeclareSiege { site: 1, entry: 0 }.to_bytes();
    let mut outer = vec![0; wix::ResidentAct::HEAD + inner.len()];
    wix::ResidentAct {
        generation: 7,
        inner: &inner,
    }
    .encode_into(&mut outer)
    .unwrap();
    let (main, proof, command, generation) = resident_context(&a, &outer).unwrap();
    assert_eq!(main.len(), 12);
    assert_eq!(proof.len(), 4);
    assert_eq!(command.to_bytes(), inner);
    assert_eq!(generation, 7);
    for i in 0..4 {
        assert_eq!(proof[i].key, a[12 + i].key);
    }
    let auth = Auth::Resident { proof, generation };
    let initial = snapshot(&a);
    assert_eq!(
        declare_siege_inner(&Pubkey::new_from_array(PROGRAM), main, &command, &auth),
        Err(FrontierError::BadData.into())
    );
    assert_eq!(snapshot(&a), initial);
    assert!(resident_context(&a[..15], &outer).is_err());

    let before = states(&a, &[4, 5]).unwrap();
    assert_eq!(before.len(), 16);
    let digest = |command: &[u8], before: &[State]| {
        receipt(
            1,
            command,
            NOW,
            10,
            &before[2].data,
            &[],
            before,
            before,
            &[],
        )
        .unwrap()
    };
    let original = digest(&outer, &before);
    let mut different_generation = outer.clone();
    different_generation[1..5].copy_from_slice(&8u32.to_le_bytes());
    assert_ne!(original, digest(&different_generation, &before));
    for i in 12..16 {
        let mut changed = before.clone();
        changed[i].data[0] ^= 0x80;
        assert_ne!(original, digest(&outer, &changed), "proof role {i}");
    }
    assert_ne!(original, digest(&inner, &before[..12]));
    let mut bad = outer.clone();
    bad[0] = wix::TAG_DEPART;
    assert!(resident_context(&a, &bad).is_err());
}

pub(in crate::proc::wide) fn resolve_fixture(
    a: &[AccountInfo<'static>],
    bell: u32,
) -> Vec<AccountInfo<'static>> {
    use crate::layout::{bell_anchor as BA, seed_cache as SC};
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let pkey = ProvinceKey::new(world_of(&ctx).unwrap(), WideCoord::checked(129, 0).unwrap());
    let clock = SeasonClock::read(&a[2].try_borrow_data().unwrap()).unwrap();
    let landed = GENESIS + (bell as i64 + 1) * 600;
    let anchor_key = ctx.bell_anchor(bell, 0);
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut ad, K2::BellAnchor, SID));
    Rw(&mut ad).set_u32(BA::BELL, bell).unwrap();
    Rw(&mut ad).set_i64(BA::A, landed).unwrap();
    Rw(&mut ad)
        .set_u64(BA::ROUND, clock.tlock_round(bell))
        .unwrap();
    Rw(&mut ad).set_u64(BA::SLOT, 1).unwrap();
    let mut sc = vec![0; K2::SeedCache.size()];
    assert!(write_header(&mut sc, K2::SeedCache, SID));
    Rw(&mut sc).set_u32(SC::BELL, bell).unwrap();
    Rw(&mut sc).set_i64(SC::A, landed).unwrap();
    Rw(&mut sc)
        .set_u64(SC::ROUND, clock.seed_round(bell, landed))
        .unwrap();
    Rw(&mut sc).set_arr(SC::ANCHOR_KEY, &anchor_key).unwrap();
    Rw(&mut sc).set_arr(SC::SEED, &[0x5a; 32]).unwrap();
    let mut inputs = vec![0; wa::wide_clash_inputs::SIZE];
    let mut ih = WideClashInputsHdr::new(SID, pkey, bell, PAYER);
    ih.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    ih.write(&mut inputs).unwrap();
    prologue::set_test_clock(landed + 120, 2_000);
    let mut roster = a[6].clone();
    roster.is_writable = true;
    vec![
        a[1].clone(),
        a[2].clone(),
        a[5].clone(),
        roster,
        ai(
            ctx.seed_cache(bell, 0, 0),
            PROGRAM,
            sc,
            1_000_000_000,
            false,
            false,
        ),
        ai(anchor_key, PROGRAM, ad, 1_000_000_000, false, false),
        ai(
            wa::clash_inputs_address(&ctx, pkey, bell),
            PROGRAM,
            inputs,
            1_000_000_000,
            false,
            true,
        ),
        ai(
            wa::arrival_day_address(&ctx, pkey, frontier_abi::addr::day_of(bell)),
            [0; 32],
            vec![],
            0,
            false,
            false,
        ),
        a[11].clone(),
        a[9].clone(),
    ]
}

#[test]
fn authenticated_resolve_commits_actual_capture_table_and_arrivals_together() {
    let a = fixture();
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        Rw(&mut pd).set_u32(PV2::SCORE_NEXT_BELL, 10).unwrap();
        Rw(&mut pd)
            .set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1)
            .unwrap();
    }
    execute(&a).unwrap();
    let required = Record::read(&a[5].try_borrow_data().unwrap(), 1)
        .unwrap()
        .required as u32;
    for bell in 10..=10 + required {
        let ra = resolve_fixture(&a, bell);
        let command = wix::ResolveWithConquest {
            bell,
            beneficiary: PAYER,
        };
        let old = wix::Resolve {
            bell,
            beneficiary: PAYER,
        };
        let before = snapshot(&ra);
        // Old Resolve is still strict and cannot consume any obligation.
        assert!(super::super::resolve_inner(
            &Pubkey::new_from_array(PROGRAM),
            &ra[..9],
            &old,
            None
        )
        .is_err());
        assert_eq!(snapshot(&ra), before);
        let lock = ra[9].try_borrow_data().unwrap();
        assert!(super::super::resolve_inner(
            &Pubkey::new_from_array(PROGRAM),
            &ra,
            &old,
            Some(&command)
        )
        .is_err());
        drop(lock);
        assert_eq!(snapshot(&ra), before);
        super::super::resolve_inner(&Pubkey::new_from_array(PROGRAM), &ra, &old, Some(&command))
            .unwrap();
        assert_eq!(
            Ro(&ra[2].try_borrow_data().unwrap())
                .u32(PV::RESOLVED_NEXT)
                .unwrap(),
            bell + 1
        );
        let ih = WideClashInputsHdr::read(&ra[6].try_borrow_data().unwrap()).unwrap();
        assert_ne!(ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED, 0);
        assert_eq!(ih.resolver, PAYER);
        let done = snapshot(&ra);
        assert!(super::super::resolve_inner(
            &Pubkey::new_from_array(PROGRAM),
            &ra,
            &old,
            Some(&command)
        )
        .is_err());
        assert_eq!(snapshot(&ra), done);
    }
    let pd = a[5].try_borrow_data().unwrap();
    let prefix = Record::read(&pd, 1).unwrap();
    assert_eq!(prefix.kind, CR::KIND_CAPTURE_DUE);
    assert_eq!(pd[PV::site(1) + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(pd[PV::site(1) + SM::GEN], 1);
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let pkey = ProvinceKey::new(world_of(&ctx).unwrap(), WideCoord::checked(129, 0).unwrap());
    let table = table_at(&a[9], &Pubkey::new_from_array(PROGRAM), &ctx, SID, pkey)
        .unwrap()
        .unwrap();
    table.validate_paired(1, prefix).unwrap();
}
