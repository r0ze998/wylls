//! Actual original capture with a public literal reverse reservation. No keys/seals.
use super::*;
use crate::layout::transit as T;
use frontier_abi::world_index::{
    expedition::AccountResolver,
    expedition_reverse_transport::{self as reverse, ReverseMarker, ReverseTransit},
    march::{self as wm, WideTransit},
    ProvinceKey, TileAddress, WideCoord, WideHostRef,
};
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
};
const ARCHIVE: &[u8] = include_bytes!(
    "../../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin"
);
fn account(owner: Pubkey, lamports: u64, data: &[u8]) -> AccountSharedData {
    let mut a = AccountSharedData::new(lamports, data.len(), &owner);
    a.set_data_from_slice(data);
    a
}
struct Input {
    p: Pubkey,
    a: Vec<(Pubkey, AccountSharedData)>,
    reverse: ReverseTransit,
    site: u8,
}
impl Input {
    fn fixture() -> Self {
        let mut at = 9;
        fn take<'a>(b: &'a [u8], at: &mut usize, n: usize) -> &'a [u8] {
            let s = *at;
            *at += n;
            &b[s..*at]
        }
        assert_eq!(&ARCHIVE[..9], b"BRESv001\x01");
        let p = Pubkey::new_from_array(take(ARCHIVE, &mut at, 32).try_into().unwrap());
        let sk: [u8; 32] = take(ARCHIVE, &mut at, 32).try_into().unwrap();
        let host = WideHostRef::from_bytes(take(ARCHIVE, &mut at, 56)).unwrap();
        let now = i64::from_le_bytes(take(ARCHIVE, &mut at, 8).try_into().unwrap());
        let tick = u64::from_le_bytes(take(ARCHIVE, &mut at, 8).try_into().unwrap());
        prologue::set_test_clock(now, tick);
        assert_eq!(take(ARCHIVE, &mut at, 1), [8]);
        let mut archive = vec![];
        for _ in 0..8 {
            let k = Pubkey::new_from_array(take(ARCHIVE, &mut at, 32).try_into().unwrap());
            let o = Pubkey::new_from_array(take(ARCHIVE, &mut at, 32).try_into().unwrap());
            take(ARCHIVE, &mut at, 4);
            let l = u64::from_le_bytes(take(ARCHIVE, &mut at, 8).try_into().unwrap());
            let n = u32::from_le_bytes(take(ARCHIVE, &mut at, 4).try_into().unwrap()) as usize;
            archive.push((k, account(o, l, take(ARCHIVE, &mut at, n))));
        }
        let ctx = addr::ctx(&sk, &p.to_bytes());
        let id = AccountResolver::for_season(&ctx)
            .unwrap()
            .legacy_host_id(&host)
            .unwrap();
        let parts = split_host_id(id).unwrap();
        let site = parts.site;
        let mut sd = archive[2].1.data().to_vec();
        let sid = Ro(&sd).u64(8).unwrap();
        Rw(&mut sd).set_u64(S::SEAL_BOND, 33).unwrap();
        let mut hd = archive[4].1.data().to_vec();
        let victim = archive[3].0;
        let vf = Ro(archive[3].1.data()).u8(C::FACTION).unwrap();
        let vs = Ro(archive[3].1.data()).u8(C::JOIN_SHARD).unwrap();
        let cf = (vf + 1) % 6;
        let wallet = [0x55; 32];
        let ck = Pubkey::new_from_array(
            ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&wallet)),
        );
        let rent = init::rent(H::SIZE).unwrap();
        let mut cd = archive[3].1.data().to_vec();
        {
            let mut w = Rw(&mut cd);
            w.set_arr(C::WALLET, &wallet).unwrap();
            w.set_u64(C::CITIZEN_TAG, citizen_tag(&ck.to_bytes()))
                .unwrap();
            w.set_u8(C::FACTION, cf).unwrap();
            w.set_u8(C::JOIN_SHARD, 0).unwrap();
            w.set_u8(C::SLOTS, C::reserved_bit(2)).unwrap();
            w.set_u64(C::TICKET_ESCROW, rent).unwrap();
            w.set_arr(C::TICKET_FUNDER, &[0x56; 32]).unwrap();
            w.set_u8(C::HOLDINGS_N, 1).unwrap();
        }
        set_holding_ref(&mut cd, 2, EMPTY_REF).unwrap();
        set_holding_ref(&mut cd, 3, EMPTY_REF).unwrap();
        let mut vd = archive[3].1.data().to_vec();
        set_holding_ref(&mut vd, 1, (0, 0, 0, 1)).unwrap();
        set_holding_ref(
            &mut vd,
            2,
            (
                parts.province.p as i16,
                parts.province.q as i16,
                site,
                parts.gen,
            ),
        )
        .unwrap();
        Rw(&mut vd).set_u8(C::HOLDINGS_N, 2).unwrap();
        let origin = ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap());
        let reverse = ReverseTransit::new(
            &ctx,
            0,
            WideTransit::depart(
                wm::HOST_IDENTITY_FULL_REF_V1,
                host,
                0,
                vf,
                TileAddress::new(origin, 0).unwrap(),
                10,
                12,
                now,
                100_000,
                100,
                10_000,
                [44; 32],
                0,
                0,
                [22; 32],
            )
            .unwrap(),
            victim.to_bytes(),
            host.key(),
        )
        .unwrap();
        let marker = ReverseMarker::new(
            &ctx,
            &reverse,
            17,
            T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
        )
        .unwrap();
        hd[H::TRANSIT..H::TRANSIT + 4 * 96].fill(0);
        hd[H::transit(0)..H::transit(0) + 96].copy_from_slice(&marker.to_bytes());
        {
            let mut w = Rw(&mut hd);
            w.set_u8(H::ORDER, 2).unwrap();
            w.set_u32(H::HOST_SEQ, parts.seq + 1).unwrap();
            w.set_u64(H::ESCROW, 70).unwrap();
        }
        let rp = Pubkey::new_from_array(Ro(&hd).arr::<32>(H::RENT_PAYER).unwrap());
        let mut pd = archive[7].1.data().to_vec();
        Rw(&mut pd)
            .set_u8(P::site(site as usize) + SM::GEN, parts.gen.wrapping_add(1))
            .unwrap();
        let src = host_id(1, 1, 0, 1, 0).unwrap();
        Record {
            kind: CR::KIND_CAPTURE_DUE,
            faction: cf,
            actor: citizen_tag(&ck.to_bytes()),
            src,
            target: CR::target(CR::TARGET_OTHER, 2),
            bell: 10,
            ..Record::ZERO
        }
        .write(&mut pd, site as usize)
        .unwrap();
        let shard = |extra| {
            let mut b = vec![0; JS::SIZE];
            assert!(frontier_abi::v2::layout::write_header(
                &mut b,
                K2::JoinShard,
                sid
            ));
            Rw(&mut b).set_u32(JS::EXTRA_HOLDINGS, extra).unwrap();
            b
        };
        let mut system = account(
            Pubkey::from_str_const("NativeLoader1111111111111111111111111111111"),
            1,
            &[],
        );
        system.set_executable(true);
        Self {
            p,
            reverse,
            site,
            a: vec![
                (
                    Pubkey::new_from_array([91; 32]),
                    account(init::SYSTEM, 1_000_000_000, &[]),
                ),
                (archive[2].0, account(p, archive[2].1.lamports(), &sd)),
                (archive[4].0, account(p, archive[4].1.lamports() + 70, &hd)),
                (archive[7].0, account(p, archive[7].1.lamports(), &pd)),
                (ck, account(p, rent + 1_000_000_000, &cd)),
                (
                    Pubkey::new_from_array(ctx.join_shard(cf, 0)),
                    account(p, 1_000_000_000, &shard(0)),
                ),
                (victim, account(p, archive[3].1.lamports(), &vd)),
                (
                    Pubkey::new_from_array(ctx.join_shard(vf, vs)),
                    account(p, 1_000_000_000, &shard(1)),
                ),
                (rp, account(init::SYSTEM, 1_000_000_000, &[])),
                (
                    Pubkey::new_from_array(ctx.holding(1, 1, 0)),
                    account(init::SYSTEM, 0, &[]),
                ),
                (init::SYSTEM, system),
            ],
        }
    }
    fn edit(&mut self, i: usize, f: impl FnOnce(&mut [u8])) {
        let mut b = self.a[i].1.data().to_vec();
        f(&mut b);
        self.a[i].1.set_data_from_slice(&b);
    }
    fn run(&self, refuse: bool) -> rt::system_cpi::Output {
        let mut a = self.a.clone();
        let mut program = account(solana_program::bpf_loader::id(), 1, &[]);
        program.set_executable(true);
        a.push((self.p, program));
        let roles = (0..11)
            .map(|i| InstructionAccount::new(i, i == 0, i != 1 && i != 10))
            .collect();
        let wire = ix2::SettleCapture {
            site: self.site,
            beneficiary: [0; 32],
        }
        .to_bytes()
        .to_vec();
        // SAFETY: official native ABI serialization/writeback; no references escape.
        unsafe {
            rt::system_cpi::run(a, 11, roles, wire, |p, a, d| {
                let result = settle_capture(p, a, d);
                if refuse {
                    assert!(result.is_err());
                    Ok(())
                } else {
                    result.map_err(Into::into)
                }
            })
        }
        .unwrap()
    }
    fn refused(&self) {
        let out = self.run(true);
        assert!(out.logs.is_empty());
        assert!(out.cpis.is_empty());
        for ((_, a), b) in self.a.iter().zip(out.accounts) {
            assert_eq!(*a, b)
        }
    }
}
#[test]
fn capture_preserves_reverse_owner_history_fee_tip_and_pays_bond_once() {
    let f = Input::fixture();
    let out = f.run(false);
    let hd = out.accounts[2].data();
    let before = Ro(f.a[2].1.data());
    let after = Ro(hd);
    assert_eq!(after.u8(H::GEN).unwrap(), before.u8(H::GEN).unwrap() + 1);
    assert_eq!(after.u8(H::PREV_GEN).unwrap(), before.u8(H::GEN).unwrap());
    assert_eq!(
        after.u64(H::PREV_OWNER_TAG).unwrap(),
        citizen_tag(&f.a[6].0.to_bytes())
    );
    assert_eq!(
        after.u64(H::PREV_HOME).unwrap(),
        holding_key(0, 0, 0, 1).unwrap()
    );
    assert_eq!(
        after.arr::<32>(H::OWNER_CITIZEN).unwrap(),
        f.a[4].0.to_bytes()
    );
    assert_eq!(after.u64(H::ESCROW).unwrap(), 37);
    assert_eq!(out.accounts[2].lamports(), f.a[2].1.lamports() - 33);
    assert_eq!(
        out.accounts[8].lamports(),
        f.a[8].1.lamports() + 33 + init::rent(H::SIZE).unwrap()
    );
    assert_eq!(holding_ref(out.accounts[6].data(), 2).unwrap(), EMPTY_REF);
    assert_eq!(Ro(out.accounts[5].data()).u32(JS::CAPTURED_IN).unwrap(), 1);
    assert_eq!(Ro(out.accounts[7].data()).u32(JS::CAPTURED_OUT).unwrap(), 1);
    let ctx = addr::ctx(&f.a[1].0.to_bytes(), &f.p.to_bytes());
    let marker = ReverseMarker::from_bytes(&ctx, &hd[H::TRANSIT..H::TRANSIT + 96]).unwrap();
    assert_eq!(marker.tip(), 17);
    assert_eq!(marker.flags(), T::FLAG_FEE_ESCROWED);
    reverse::authenticate_pair(
        &ctx,
        &f.a[2].0.to_bytes(),
        0,
        &wm::transit_address(&ctx, &f.a[2].0.to_bytes(), 0),
        &marker,
        &f.reverse,
    )
    .unwrap();
    assert_eq!(
        ap::holding_transit_occupancy(&ctx, &f.a[2].0.to_bytes(), hd).unwrap()[0],
        ap::TransitOccupancy::Reverse(marker)
    );
    assert!(out.cpis.is_empty());
    assert!(!out.logs.is_empty());
    // Replay another actual capture-due record after the first writeback. The
    // single previous-owner/home history must not be overwritten by generation 3.
    let mut second = Input::fixture();
    for (i, (_, account)) in second.a.iter_mut().enumerate() {
        *account = out.accounts[i].clone();
    }
    second.edit(3, |pd| {
        Record::read(f.a[3].1.data(), f.site as usize)
            .unwrap()
            .write(pd, f.site as usize)
            .unwrap();
        Rw(pd)
            .set_u8(
                P::site(f.site as usize) + SM::GEN,
                before.u8(H::GEN).unwrap() + 2,
            )
            .unwrap();
    });
    second.refused();
}
#[test]
fn reverse_capture_refuses_history_overwrite_malformed_later_slots_and_underfunding_before_effects()
{
    let mut f = Input::fixture();
    f.edit(2, |b| {
        let g = Ro(b).u8(H::GEN).unwrap();
        Rw(b).set_u8(H::GEN, g + 1).unwrap()
    });
    f.refused();
    let mut f = Input::fixture();
    f.edit(2, |b| {
        b[H::transit(3)] = 4;
        b[H::transit(3) + T::RSV_93] = 2;
    });
    f.refused();
    let mut f = Input::fixture();
    f.edit(2, |b| Rw(b).set_u64(H::ESCROW, 32).unwrap());
    f.refused();
    let mut f = Input::fixture();
    f.edit(2, |b| {
        b[H::transit(3) + T::STATE] = 1;
        b[H::transit(3) + T::FLAGS] = T::FLAG_BOND_ESCROWED;
        Rw(b).set_u64(H::ESCROW, 50).unwrap();
    });
    f.refused();
    let mut f = Input::fixture();
    f.edit(2, |b| b[H::transit(0) + T::RSV_93] = 3);
    f.refused();
    let mut f = Input::fixture();
    f.edit(2, |b| {
        Rw(b)
            .set_u64(H::transit(0) + T::HOST_ID, host_id(1, 1, 0, 1, 0).unwrap())
            .unwrap()
    });
    f.refused();
    let mut f = Input::fixture();
    f.edit(4, |b| Rw(b).set_u64(C::TICKET_ESCROW, 0).unwrap());
    f.refused();
    let mut f = Input::fixture();
    f.edit(2, |b| Rw(b).set_u32(H::HOST_SEQ, 0).unwrap());
    f.refused();
}

#[test]
fn dormant_release_refuses_reverse_occupancy_without_writeback() {
    let mut f = Input::fixture();
    f.edit(2, |b| {
        Rw(b).set_u8(H::ORDER, 1).unwrap();
        Rw(b).set_i64(H::LAST_OWNER_ACTION, 0).unwrap();
    });
    f.edit(1, |b| {
        Rw(b).set_u32(S::RELEASE_AFTER_SECS, 1).unwrap();
    });
    let ctx = addr::ctx(&f.a[1].0.to_bytes(), &f.p.to_bytes());
    let mut accounts = f.a.clone();
    accounts.push((
        Pubkey::new_from_array(ctx.defence_pool()),
        account(init::SYSTEM, 0, &[]),
    ));
    let mut program = account(solana_program::bpf_loader::id(), 1, &[]);
    program.set_executable(true);
    accounts.push((f.p, program));
    let roles = [0, 1, 2, 3, 6, 7, 8, 11]
        .into_iter()
        .map(|i| InstructionAccount::new(i, i == 0, i != 1))
        .collect();
    let wire = frontier_abi::ix::ReleaseDormant {}.to_bytes().to_vec();
    let out = unsafe {
        rt::system_cpi::run(accounts, 12, roles, wire, |p, a, d| {
            assert_eq!(
                super::super::citizen::release_dormant(p, a, d),
                Err(FrontierError::NotDormant.into())
            );
            Ok(())
        })
    }
    .unwrap();
    assert!(out.logs.is_empty());
    assert!(out.cpis.is_empty());
    for ((_, a), b) in f.a.iter().zip(out.accounts) {
        assert_eq!(*a, b)
    }
}
