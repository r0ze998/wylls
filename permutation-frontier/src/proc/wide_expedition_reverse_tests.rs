//! Exact native writeback from immutable public resident account bytes.
//! No valid seal, opening key, signature, transaction, RPC or fixture export.
use super::*;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, ReadableAccount, RunError, WritableAccount,
};
const ARCHIVE: &[u8] = include_bytes!(
    "../../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin"
);
struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> &[u8] {
        let a = self.at;
        self.at += n;
        &self.b[a..self.at]
    }
    fn arr<const N: usize>(&mut self) -> [u8; N] {
        self.take(N).try_into().unwrap()
    }
}
fn literal(owner: Pubkey, lamports: u64, data: &[u8]) -> AccountSharedData {
    let mut a = AccountSharedData::new(lamports, data.len(), &owner);
    a.set_data_from_slice(data);
    a
}
struct Input {
    p: Pubkey,
    accounts: Vec<(Pubkey, AccountSharedData)>,
    roles: Vec<InstructionAccount>,
    command: ix::Depart,
    now: i64,
}
impl Input {
    fn fixture() -> Self {
        assert_eq!(
            sha256(&[ARCHIVE]),
            [
                0x0d, 0x46, 0xcd, 0x2d, 0x17, 0x5c, 0x57, 0xc9, 0x47, 0xaf, 0x8e, 0x67, 0xf1, 0x4f,
                0x2d, 0x00, 0x2e, 0x18, 0xc9, 0xe7, 0xe7, 0xd4, 0x7f, 0xb4, 0xa9, 0x44, 0xe9, 0x80,
                0x23, 0xf3, 0x9a, 0x84
            ]
        );
        let mut r = Reader { b: ARCHIVE, at: 0 };
        assert_eq!(r.take(9), b"BRESv001\x01");
        let p = Pubkey::new_from_array(r.arr());
        let sk = r.arr();
        let host = WideHostRef::from_bytes(&r.arr::<56>()).unwrap();
        let now = i64::from_le_bytes(r.arr());
        let slot = u64::from_le_bytes(r.arr());
        assert_eq!(r.take(1), [8]);
        prologue::set_test_clock(now, slot);
        let mut accounts = vec![];
        for _ in 0..8 {
            let key = Pubkey::new_from_array(r.arr());
            let owner = Pubkey::new_from_array(r.arr());
            let flags = r.arr::<4>();
            assert_eq!(flags[3], 0);
            let lamports = u64::from_le_bytes(r.arr());
            let len = u32::from_le_bytes(r.arr()) as usize;
            accounts.push((key, literal(owner, lamports, r.take(len))));
        }
        let ctx = addr::ctx(&sk, &p.to_bytes());
        let r = AccountResolver::for_season(&ctx).unwrap();
        let destination = host.key();
        let mut system = literal(
            Pubkey::from_str_const("NativeLoader1111111111111111111111111111111"),
            1,
            &[],
        );
        system.set_executable(true);
        accounts.push((init::SYSTEM, system));
        accounts.push((
            Pubkey::new_from_array(wm::transit_address(&ctx, &accounts[4].0.to_bytes(), 0)),
            literal(init::SYSTEM, 0, &[]),
        ));
        let bell = SeasonClock::read(accounts[2].1.data())
            .unwrap()
            .bell_at(now)
            .unwrap();
        // Public literal readiness adjustment: this tests producer contracts, not
        // a claim that the historical archive itself authorized this new action.
        let mut pd = accounts[5].1.data().to_vec();
        let roster = WideRoster::read(accounts[6].1.data()).unwrap();
        let mut entry = None;
        for i in 0..PV::ENTRIES_N {
            let e = read_entry(&pd, i).unwrap();
            if roster.entry_matches(accounts[6].1.data(), i, e.id, &host) {
                entry = Some((i, e));
                break;
            }
        }
        let (i, mut e) = entry.unwrap();
        e.stamina_value = 100;
        e.stamina_bell = bell;
        e.ready_bell = bell;
        write_entry(&mut pd, i, &e).unwrap();
        accounts[5].1.set_data_from_slice(&pd);
        assert_eq!(
            r.province_address(destination).unwrap(),
            accounts[7].0.to_bytes()
        );
        let roles = [
            (0, true, false),
            (1, true, true),
            (2, false, false),
            (3, false, true),
            (4, false, true),
            (5, false, true),
            (8, false, false),
            (7, false, false),
            (9, false, true),
            (6, false, false),
            (7, false, false),
        ]
        .into_iter()
        .map(|(i, s, w)| InstructionAccount::new(i, s, w))
        .collect();
        let mut seal = [0; wseal::WIDE_SEAL_LEN];
        seal[0] = 0x80; // shape only; not a valid ciphertext
        let command = ix::Depart {
            host,
            destination,
            slot: 0,
            arrive_bell: bell + 2,
            tip: fees::min_tip_lamports(
                Ro(accounts[2].1.data())
                    .u32(S::MIN_REVEAL_PRIORITY_MILLI)
                    .unwrap(),
                Ro(accounts[2].1.data()).u32(S::REVEAL_CU_LIMIT).unwrap(),
                Ro(accounts[2].1.data())
                    .u32(S::REVEAL_LOADED_LIMIT)
                    .unwrap(),
            ) + 1000,
            commit: [0x31; 32],
            seal,
        };
        Self {
            p,
            accounts,
            roles,
            command,
            now,
        }
    }
    fn run(
        &self,
        roles: Vec<InstructionAccount>,
        wire: Vec<u8>,
        helper: impl for<'b, 'a> FnOnce(
            &'b Pubkey,
            &'a [AccountInfo<'b>],
            &'b [u8],
        )
            -> Result<(), solana_program::program_error::ProgramError>,
    ) -> Result<rt::system_cpi::Output, RunError> {
        let mut accounts = self.accounts.clone();
        let index = accounts.len() as u16;
        let mut program = literal(solana_program::bpf_loader::id(), 1, &[]);
        program.set_executable(true);
        accounts.push((self.p, program));
        // SAFETY: official ABIv1 serialization; no account reference escapes callback.
        unsafe { rt::system_cpi::run(accounts, index, roles, wire, helper) }
    }
    fn depart(&self) -> Result<rt::system_cpi::Output, RunError> {
        self.run(
            self.roles.clone(),
            self.command.to_bytes().to_vec(),
            |p, a, d| execute_depart(p, a, d).map_err(Into::into),
        )
    }
    fn refuse(&self) {
        let out = self
            .run(
                self.roles.clone(),
                self.command.to_bytes().to_vec(),
                |p, a, d| {
                    assert!(execute_depart(p, a, d).is_err());
                    Ok(())
                },
            )
            .unwrap();
        assert!(out.cpis.is_empty());
        assert!(out.logs.is_empty());
        for ((_, a), b) in self.accounts.iter().zip(out.accounts) {
            assert_eq!(*a, b)
        }
    }
}
#[test]
fn reverse_producer_allocates_real_transit_reserves_money_and_locks_old_consumers() {
    let mut f = Input::fixture();
    let original = f.accounts.clone();
    let out = f.depart().unwrap();
    let ctx = addr::ctx(&f.accounts[2].0.to_bytes(), &f.p.to_bytes());
    let r = ReverseTransit::from_bytes(&ctx, out.accounts[9].data()).unwrap();
    assert_eq!(r.destination(), f.command.destination);
    assert_eq!(r.transit().host, f.command.host);
    assert_ne!(r.transit().origin.key(), r.transit().host.key());
    assert_eq!(r.original_owner(), f.accounts[3].0.to_bytes());
    assert_eq!(r.transit().state, MarchState::Departed);
    assert_eq!(out.accounts[9].data().len(), transport::LEN);
    assert_eq!(out.accounts[9].owner(), &f.p);
    let marker = ReverseMarker::from_bytes(
        &ctx,
        &out.accounts[4].data()[H::transit(0)..H::transit(0) + 96],
    )
    .unwrap();
    transport::authenticate_pair(
        &ctx,
        &f.accounts[4].0.to_bytes(),
        0,
        &f.accounts[9].0.to_bytes(),
        &marker,
        &r,
    )
    .unwrap();
    assert_eq!(marker.tip(), f.command.tip);
    let sr = Ro(original[2].1.data());
    let total = f.command.tip + sr.u64(S::MARCH_FEE).unwrap() + sr.u64(S::SEAL_BOND).unwrap();
    assert_eq!(out.accounts[4].lamports(), original[4].1.lamports() + total);
    assert_eq!(
        Ro(out.accounts[4].data()).u64(H::ESCROW).unwrap(),
        Ro(original[4].1.data()).u64(H::ESCROW).unwrap() + total
    );
    assert_eq!(
        out.accounts[1].lamports(),
        original[1].1.lamports() - total - init::rent(transport::LEN).unwrap()
    );
    assert_eq!(out.accounts[6], original[6].1);
    assert_eq!(out.accounts[7], original[7].1);
    assert_eq!(out.logs.len(), 1);
    let id = AccountResolver::for_season(&ctx)
        .unwrap()
        .legacy_host_id(&f.command.host)
        .unwrap();
    assert!(ap::host_in_transit_with_bridge(
        &ctx,
        &f.accounts[4].0.to_bytes(),
        out.accounts[4].data(),
        id
    )
    .unwrap());
    assert!(matches!(
        ap::holding_transit_occupancy(&ctx, &f.accounts[4].0.to_bytes(), out.accounts[4].data())
            .unwrap()[0],
        ap::TransitOccupancy::Reverse(_)
    ));
    assert!(
        frontier_abi::world_index::expedition_transport::OwnedBridgeTransit::from_bytes(
            &ctx,
            out.accounts[9].data()
        )
        .is_err()
    );
    assert!(
        frontier_abi::world_index::expedition_bridge::BridgeMarker::from_bytes(
            &ctx,
            &marker.to_bytes()
        )
        .is_err()
    );
    assert!(wix::WideCommand::decode(&f.command.to_bytes()).is_err());
    assert!(frontier_abi::v2::ix::tag_of(&f.command.to_bytes()).is_err());
    for ((_, a), b) in f.accounts.iter_mut().zip(out.accounts) {
        *a = b;
    }
    f.refuse();
}
#[test]
fn reverse_producer_refuses_false_owner_generation_slot_alias_and_late_borrow() {
    for case in 0..12 {
        let mut f = Input::fixture();
        match case {
            0 => f.roles[0] = InstructionAccount::new(0, false, false),
            1 => {
                let mut d = f.accounts[4].1.data().to_vec();
                Rw(&mut d).set_u8(H::GEN, f.command.host.gen() + 1).unwrap();
                f.accounts[4].1.set_data_from_slice(&d)
            }
            2 => {
                let mut d = f.accounts[4].1.data().to_vec();
                Rw(&mut d)
                    .set_u32(H::HOST_SEQ, f.command.host.seq())
                    .unwrap();
                f.accounts[4].1.set_data_from_slice(&d)
            }
            3 => f.roles[9] = InstructionAccount::new(5, false, true),
            4 => f.command.slot = 4,
            5 => f.command.seal[0] = 0,
            6 => f.accounts[1].1.set_lamports(0),
            7 => {
                let mut d = f.accounts[4].1.data().to_vec();
                d[H::transit(3) + T::STATE] = 255;
                f.accounts[4].1.set_data_from_slice(&d)
            }
            8 => {
                let mut d = f.accounts[4].1.data().to_vec();
                Rw(&mut d).set_arr(H::OWNER_CITIZEN, &[0x55; 32]).unwrap();
                f.accounts[4].1.set_data_from_slice(&d)
            }
            9 => {
                let mut d = f.accounts[4].1.data().to_vec();
                let ctx = addr::ctx(&f.accounts[2].0.to_bytes(), &f.p.to_bytes());
                let id = AccountResolver::for_season(&ctx)
                    .unwrap()
                    .legacy_host_id(&f.command.host)
                    .unwrap();
                Rw(&mut d).set_u8(H::transit(3) + T::STATE, 1).unwrap();
                Rw(&mut d).set_u64(H::transit(3) + T::HOST_ID, id).unwrap();
                f.accounts[4].1.set_data_from_slice(&d)
            }
            10 => {
                let mut d = f.accounts[6].1.data().to_vec();
                d[frontier_abi::world_index::roster::wide_roster::REFS..].fill(0);
                f.accounts[6].1.set_data_from_slice(&d)
            }
            _ => {
                let ctx = addr::ctx(&f.accounts[2].0.to_bytes(), &f.p.to_bytes());
                f.command.destination =
                    ProvinceKey::new(world_of(&ctx).unwrap(), WideCoord::checked(129, 0).unwrap())
            }
        }
        f.refuse();
    }
    let f = Input::fixture();
    let out = f
        .run(f.roles.clone(), f.command.to_bytes().to_vec(), |p, a, d| {
            let _guard = a[5].try_borrow_data()?;
            assert!(execute_depart(p, a, d).is_err());
            Ok(())
        })
        .unwrap();
    assert!(out.cpis.is_empty());
    for ((_, a), b) in f.accounts.iter().zip(out.accounts) {
        assert_eq!(*a, b)
    }
}
#[test]
fn reverse_origin_uses_resolved_spend_and_releases_paired_wide_row() {
    let mut f = Input::fixture();
    let out = f.depart().unwrap();
    for ((_, a), b) in f.accounts.iter_mut().zip(out.accounts) {
        *a = b;
    }
    let ctx = addr::ctx(&f.accounts[2].0.to_bytes(), &f.p.to_bytes());
    let r = ReverseTransit::from_bytes(&ctx, f.accounts[9].1.data()).unwrap();
    let t = r.transit();
    let mut pd = f.accounts[5].1.data().to_vec();
    let roster = WideRoster::read(f.accounts[6].1.data()).unwrap();
    let mut index = None;
    for i in 0..PV::ENTRIES_N {
        let e = read_entry(&pd, i).unwrap();
        if roster.entry_matches(f.accounts[6].1.data(), i, e.id, &t.host) {
            index = Some(i);
            break;
        }
    }
    let i = index.unwrap();
    let mut e = read_entry(&pd, i).unwrap();
    let mut host = e.to_host().unwrap();
    host.apply_clash(t.depart_bell, e.troops, 90, true).unwrap();
    host.settle(t.depart_bell + 1).unwrap();
    e.set_host(&host);
    e.state = E::STATE_DEPARTED;
    write_entry(&mut pd, i, &e).unwrap();
    Rw(&mut pd)
        .set_u32(PV::RESOLVED_NEXT, t.depart_bell + 1)
        .unwrap();
    f.accounts[5].1.set_data_from_slice(&pd);
    prologue::set_test_clock(f.now + 600, 7000);
    let roles = [
        (1, true, true),
        (2, false, false),
        (4, false, true),
        (7, false, false),
        (5, false, true),
        (6, false, true),
        (9, false, true),
    ]
    .into_iter()
    .map(|(i, s, w)| InstructionAccount::new(i, s, w))
    .collect::<Vec<_>>();
    let out = f
        .run(roles.clone(), vec![0], |p, a, _| {
            execute_origin(p, a, 0).map_err(Into::into)
        })
        .unwrap();
    let next = ReverseTransit::from_bytes(&ctx, out.accounts[9].data()).unwrap();
    assert_eq!(next.transit().state, MarchState::Settled);
    assert_eq!(next.transit().troops_after, t.dep_mass);
    assert_eq!(read_entry(out.accounts[5].data(), i).unwrap(), Entry::FREE);
    assert!(WideRoster::read(out.accounts[6].data())
        .unwrap()
        .table(out.accounts[6].data())
        .unwrap()
        .iter()
        .all(|(_, _, host)| *host != t.host));
    assert_eq!(out.accounts[4].lamports(), f.accounts[4].1.lamports());
    assert_eq!(
        &out.accounts[4].data()[H::transit(0)..H::transit(0) + 96],
        &f.accounts[4].1.data()[H::transit(0)..H::transit(0) + 96]
    );
    let marker = ReverseMarker::from_bytes(
        &ctx,
        &out.accounts[4].data()[H::transit(0)..H::transit(0) + 96],
    )
    .unwrap();
    transport::authenticate_pair(
        &ctx,
        &f.accounts[4].0.to_bytes(),
        0,
        &f.accounts[9].0.to_bytes(),
        &marker,
        &next,
    )
    .unwrap();
    let gathered = next.gather_worn(&ctx, next.destination(), 100).unwrap();
    assert_eq!(
        gathered.gather_worn(&ctx, next.destination(), 100).unwrap(),
        gathered
    );
    transport::authenticate_pair(
        &ctx,
        &f.accounts[4].0.to_bytes(),
        0,
        &f.accounts[9].0.to_bytes(),
        &marker,
        &gathered,
    )
    .unwrap();
}
