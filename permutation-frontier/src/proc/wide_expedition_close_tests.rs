//! Refusal-only ordinary AccountInfo fixtures. No unsafe host backing,
//! resize/assign success, syscall overrides, signing, RNG or CPI.
//! Positive proposal is noncompiled .rs.txt: its SDK contract remains
//! unresolved. These tests never establish successful close or rent payout.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use solana_program::program_error::ProgramError;
const PROGRAM: [u8; 32] = [0x12; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const RENT_TO: [u8; 32] = [0x24; 32];
const BALANCE: u64 = 1_000_000_000;
fn ai(k: [u8;32], o: [u8;32], d: Vec<u8>, lamports: u64, signer: bool, writable: bool) -> AccountInfo<'static> {
    AccountInfo::new(Box::leak(Box::new(Pubkey::new_from_array(k))), signer, writable,
        Box::leak(Box::new(lamports)), Box::leak(d.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(o))), false)
}
fn fixture() -> (Vec<AccountInfo<'static>>, AddrCtx) {
    prologue::set_test_clock(GENESIS + 6600, 77);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump = Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = frontier_abi::world_index::expedition::AccountResolver::for_season(&ctx).unwrap();
    let host = resolver.legacy_host_ref(addr::host_id(128, 0, 2, 1, 0).unwrap()).unwrap();
    let dest = ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
    let s = WideArrivalSlot {
        season_id: SID, dest, bell: 10, faction: 2, i: 0, transit_slot: 0,
        host, citizen: [0x33; 32], unit: 1, stance: 0, tile: 3,
        retreat_bps: 0, dealt_bps: 10000, dep_mass: 100000,
        flags: wa::wide_arrival_slot::FLAG_SETTLED,
        beneficiary: [0x35; 32], rent_to: RENT_TO, ev_slot: 50,
        ev_price: 0, ev_limit: 0, ev_loaded: 0, claimed: true,
    };
    let slot = ExpeditionArrivalSlot::new(&ctx, s, 1000).unwrap().to_bytes(&ctx).unwrap();
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION).unwrap();
    w.set_i64(S::GENESIS_TS, GENESIS).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_i64(S::DRAND_GENESIS, GENESIS - 100).unwrap();
    w.set_u32(S::DRAND_PERIOD, 3).unwrap();
    w.set_u32(S::REVEAL_WINDOW, 60).unwrap();
    w.set_u32(S::WINDOW_NEXT, 60).unwrap();
    w.set_u32(S::SEED_MARGIN, 60).unwrap();
    (vec![
        ai([0x44;32], [0;32], vec![], 0, true, false),
        ai(sk, PROGRAM, sd, BALANCE, false, false),
        ai(wa::arrival_slot_address(&ctx, dest, 10, 2, 0), PROGRAM,
           slot.to_vec(), BALANCE, false, true),
        ai(RENT_TO, [0;32], vec![], BALANCE, false, true),
    ], ctx)
}

fn edit(a: &[AccountInfo], ctx: &AddrCtx, f: impl FnOnce(&mut WideArrivalSlot)) {
    let old = ExpeditionArrivalSlot::read(ctx, &a[2].try_borrow_data().unwrap()).unwrap();
    let mut common = *old.common();
    f(&mut common);
    let bytes = ExpeditionArrivalSlot::new(ctx, common, old.worn_bps()).unwrap().to_bytes(ctx).unwrap();
    a[2].try_borrow_mut_data().unwrap().copy_from_slice(&bytes);
}
fn snapshot(a: &[AccountInfo]) -> Vec<(u64, Vec<u8>, Pubkey)> {
    a.iter().map(|x| (x.lamports(), x.try_borrow_data().unwrap().to_vec(), *x.owner)).collect()
}
fn run(a: &[AccountInfo]) -> R<()> { close_slot(&Pubkey::new_from_array(PROGRAM), a) }

fn refuses(a: &[AccountInfo], expected: crate::Error) {
    let before = snapshot(a);
    // Retain shared slot data: even mistaken eligibility acceptance stops at
    // preflight, before close_to. Exact errors prevent false-positive passes.
    let _data = a[2].try_borrow_data().unwrap();
    assert_eq!(run(a), Err(expected));
    assert_eq!(snapshot(a), before);
}
#[test]
fn refuses_invalid_v2_identity_flags_addresses_and_balances() {
    for case in 0..20 {
        let (mut a, ctx) = fixture();
        let expected = match case {
            0 => { a[0].is_signer = false; FrontierError::Auth.into() },
            1 => { a[2].is_writable = false; BAD_ACCOUNT },
            2 => { a[3].is_writable = false; BAD_ACCOUNT },
            3 => { a[2].owner = Box::leak(Box::new(Pubkey::new_from_array([0;32]))); BAD_ACCOUNT },
            4 => { a[2].key = Box::leak(Box::new(Pubkey::new_from_array([0x55;32]))); FrontierError::BadAddress.into() },
            5 => { a[3].key = Box::leak(Box::new(Pubkey::new_from_array([0x55;32]))); FrontierError::BadAddress.into() },
            6 => { a[3] = a[2].clone(); BAD_ACCOUNT },
            7 => { **a[3].try_borrow_mut_lamports().unwrap() = u64::MAX; OVERFLOW },
            8 => { **a[2].try_borrow_mut_lamports().unwrap() = 1; **a[3].try_borrow_mut_lamports().unwrap() = 0; BAD_ACCOUNT },
            9 => { edit(&a, &ctx, |s| s.season_id += 1); BAD_ACCOUNT },
            10 => { a[2].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::FAMILY_VERSION] = 0xff; BAD_ACCOUNT },
            11 => { a[2].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::RSV_29] = 1; BAD_ACCOUNT },
            12 => { edit(&a, &ctx, |s| s.flags = 0); FrontierError::TooEarly.into() },
            13 => { edit(&a, &ctx, |s| s.claimed = false); FrontierError::TooEarly.into() },
            14 => { a[2].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::CITIZEN..wa::wide_arrival_slot::CITIZEN + 32].fill(0); BAD_ACCOUNT },
            15 => { a[2].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::HOST] = 0xff; BAD_ACCOUNT },
            16 => { a[2].try_borrow_mut_data().unwrap()[wa::wide_arrival_slot::RSV_188..wa::wide_arrival_slot::RSV_188 + 2].copy_from_slice(&u16::MAX.to_le_bytes()); BAD_ACCOUNT },
            17 => {
                let s = *ExpeditionArrivalSlot::read(&ctx, &a[2].try_borrow_data().unwrap()).unwrap().common();
                s.write(&mut a[2].try_borrow_mut_data().unwrap()).unwrap(); BAD_ACCOUNT
            },
            18 => { a[3].lamports = a[2].lamports.clone(); BAD_ACCOUNT },
            19 => { a[0].data = a[2].data.clone(); BAD_ACCOUNT },
            _ => unreachable!(),
        };
        refuses(&a, expected);
    }
}
#[test]
fn refuses_shared_and_exclusive_borrows_without_effects() {
    let borrow_error: crate::Error = ProgramError::AccountBorrowFailed.into();
    for index in 0..4 {
        let (a, _) = fixture();
        let before = snapshot(&a);
        { let _b = a[index].try_borrow_mut_lamports().unwrap();
          assert_eq!(run(&a), Err(borrow_error.clone())); }
        assert_eq!(snapshot(&a), before);
        { let _b = a[index].try_borrow_mut_data().unwrap();
          assert_eq!(run(&a), Err(borrow_error.clone())); }
        assert_eq!(snapshot(&a), before);
    }
    let (a, _) = fixture();
    refuses(&a, borrow_error.clone());
    for index in [2, 3] {
        let (a, _) = fixture();
        let _b = a[index].try_borrow_lamports().unwrap();
        refuses(&a, borrow_error.clone());
    }
}
#[test]
fn refuses_before_grace_and_end_deadlines() {
    let (mut a, ctx) = fixture();
    edit(&a, &ctx, |s| s.claimed = false);
    let s = *ExpeditionArrivalSlot::read(&ctx, &a[2].try_borrow_data().unwrap()).unwrap().common();
    let ak = ctx.bell_anchor(s.bell, absent_destination_region(s.dest.coord()));
    a.push(ai([0x77;32], [0;32], vec![], 0, false, false));
    refuses(&a, FrontierError::BadAddress.into());
    let mut ad = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut ad, K2::BellAnchor, SID));
    Rw(&mut ad).set_i64(crate::layout::beacon::bell_anchor::A, GENESIS + 6000).unwrap();
    a[4] = ai(ak, PROGRAM, ad, BALANCE, false, false);
    prologue::set_test_clock(GENESIS + 6000 + 60 + 3600 - 1, 77);
    refuses(&a, FrontierError::TooEarly.into());
    // At the boundary eligibility passes, but the safety borrow stops at
    // preflight. This is NOT evidence of successful close.
    prologue::set_test_clock(GENESIS + 6000 + 60 + 3600, 77);
    refuses(&a, ProgramError::AccountBorrowFailed.into());
    let (a, ctx) = fixture();
    edit(&a, &ctx, |s| { s.flags = 0; s.claimed = false; });
    Rw(&mut a[1].try_borrow_mut_data().unwrap()).set_u8(S::STATUS, S::STATUS_ENDED).unwrap();
    let end = GENESIS + 1000 * 600 + super::super::super::map::END_GRACE_SECS;
    prologue::set_test_clock(end - 1, 77);
    refuses(&a, FrontierError::TooEarly.into());
    prologue::set_test_clock(end, 77);
    refuses(&a, ProgramError::AccountBorrowFailed.into());
}
