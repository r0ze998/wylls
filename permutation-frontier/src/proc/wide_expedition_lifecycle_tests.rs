//! Continuous unsigned native boundary lifecycle. Synthetic *initial* Season,
//! Citizen, Holding, original/wide provinces and public beacon prior accounts
//! are explicit. Intermediate departure, origin combat, bridge, Reveal, Gather
//! and destination combat state is exclusively the output of actual handlers.
//! This does not prove historical opening/anchor producers, signatures, bank
//! rollback, SBF behavior, UI/keeper integration or public gameplay activation.
use super::*;
use crate::crypto::quick::tests::{decode, FIXTURE_HINTS_HEX, FIXTURE_ROUND, FIXTURE_SIG_HEX};
use crate::crypto::{quick, xmd};
use crate::layout::{bell_anchor as BA, clash_inputs as CI, seed_cache as SC};
use crate::proc::wide::expedition_exec;
use alloc::boxed::Box;
use frontier_abi::entry::{read_entry, write_entry, Entry};
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::presets::{FRONTIER_7, SEASON_CQ_OFFSET};
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, ReadableAccount, WritableAccount,
};

const PROGRAM: [u8; 32] = [0x12; 32];
const WALLET: [u8; 32] = [0xa1; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const SID: u64 = 11;
const GENESIS: i64 = permutation_rules::frontier::beacon::QUICKNET.genesis
    + (FIXTURE_ROUND as i64 - 1) * 3
    - 13 * 600;
const NOW: i64 = GENESIS + 6000;
const ARRIVE: u32 = 12;
const LANDED: i64 = GENESIS + 7807;

fn ai(
    address: [u8; 32],
    owner: [u8; 32],
    bytes: Vec<u8>,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        signer,
        writable,
        Box::leak(Box::new(1_000_000_000)),
        Box::leak(bytes.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}

fn initial_fixture() -> (Vec<AccountInfo<'static>>, wix::ExpeditionDepart) {
    prologue::set_test_clock(NOW, 1);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump = Pubkey::find_program_address(
        &[
            crate::addr::SEASON_PREFIX,
            &crate::addr::season_seed_id(SID),
        ],
        &p,
    )
    .1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
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
    let mut cd = vec![0; K2::Citizen.size()];
    assert!(write_header(&mut cd, K2::Citizen, SID));
    let mut w = Rw(&mut cd);
    w.set_arr(C::WALLET, &WALLET).unwrap();
    w.set_u8(
        C::FLAGS,
        C::FLAG_JOINED | C::FLAG_HOME_GRANTED | C::FLAG_FIRST_HOLDING_FINAL,
    )
    .unwrap();
    w.set_u32(C::BUCKET_MILLI, 20_000).unwrap();
    w.set_u32(C::TICKET_BELL, C::NO_TICKET).unwrap();
    w.set_u64(C::CITIZEN_TAG, frontier_abi::addr::citizen_tag(&ck))
        .unwrap();
    cd[C2::holding_of_slot(1)..C2::holding_of_slot(1) + 6].copy_from_slice(&[128, 0, 0, 0, 0, 1]);
    cd[C2::HOLDINGS_N] = 1;
    for slot in 2..=3 {
        cd[C2::holding_of_slot(slot) + 5] = C2::EMPTY_GEN;
    }
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let economy = cz::founded_holding(NOW, addr::day_of(10), 0).unwrap();
    write_founding(
        &mut hd,
        &Founding {
            p: 128,
            q: 0,
            site: 0,
            gen: 1,
            tile: 0,
            owner: ck,
            score: 0,
            faction: 0,
            ticket_bell: C::NO_TICKET,
            rent_payer: WALLET,
            final_ts: NOW,
            pool_owed: 0,
            shield_until: NOW,
            terrain_ore: 0,
        },
        &economy,
    )
    .unwrap();
    hd[H::STATE] = H::STATE_FINAL;
    Rw(&mut hd).set_u32(H::HOST_SEQ, 1).unwrap();
    let mut pd = vec![0; K2::Province.size()];
    assert!(write_header(&mut pd, K2::Province, SID));
    Rw(&mut pd).set_i16(PV::P, 128).unwrap();
    Rw(&mut pd).set_u32(PV::RESOLVED_NEXT, 10).unwrap();
    pd[PV::SITE_COUNT] = 1;
    pd[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    pd[PV::site(0) + SM::GEN] = 1;
    pd[PV::site(0) + SM::ORDER] = 1;
    pd[PV::N_ENTRIES] = 1;
    let id = frontier_abi::addr::host_id(128, 0, 0, 1, 0).unwrap();
    write_entry(
        &mut pd,
        0,
        &Entry {
            id,
            unit: 0,
            faction: 0,
            tile: 1,
            state: E::STATE_ROSTER,
            troops: 200_000,
            stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
            stamina_bell: 10,
            from_bell: 1,
            ..Entry::FREE
        },
    )
    .unwrap();
    let host = AccountResolver::for_season(&ctx)
        .unwrap()
        .legacy_host_ref(id)
        .unwrap();
    let hk = ctx.holding(128, 0, 0);
    let province = ai(ctx.province(128, 0), PROGRAM, pd, false, true);
    let a = vec![
        ai(WALLET, [0; 32], vec![], true, false),
        ai([0xd4; 32], [0; 32], vec![], true, true),
        ai(sk, PROGRAM, sd, false, false),
        ai(ck, PROGRAM, cd, false, true),
        ai(hk, PROGRAM, hd, false, true),
        province.clone(),
        ai([0; 32], [0; 32], vec![], false, false),
        province,
        ai(
            wm::transit_address(&ctx, &hk, 0),
            [0; 32],
            vec![],
            false,
            true,
        ),
    ];
    let mut seal = [0; frontier_abi::world_index::seal::WIDE_SEAL_LEN];
    seal[0] = 0x80;
    let tip = {
        let sd = a[2].try_borrow_data().unwrap();
        let r = Ro(&sd);
        fees::min_tip_lamports(
            r.u32(S::MIN_REVEAL_PRIORITY_MILLI).unwrap(),
            r.u32(S::REVEAL_CU_LIMIT).unwrap(),
            r.u32(S::REVEAL_LOADED_LIMIT).unwrap(),
        )
    };
    // Zero priority still includes the existing 2,500-lamport base; this
    // fixture's march fee and bond are explicitly zero, not waived by code.
    assert_eq!(tip, 2_500);
    (
        a,
        wix::ExpeditionDepart {
            host: host.to_bytes(),
            transit_slot: 0,
            arrive_bell: 12,
            tip,
            commit: [0x31; 32],
            seal,
        },
    )
}

fn literal(owner: Pubkey, balance: u64, data: &[u8]) -> AccountSharedData {
    let mut a = AccountSharedData::new(balance, data.len(), &owner);
    a.set_data_from_slice(data);
    a
}
#[derive(Clone)]
struct World(
    Vec<(Pubkey, AccountSharedData)>,
    Vec<(i64, u64, Vec<Vec<Vec<u8>>>)>,
);
impl World {
    fn from_infos(infos: &[AccountInfo]) -> Self {
        let mut world = Self(vec![], vec![]);
        for a in infos {
            if !world.0.iter().any(|(k, _)| k == a.key) {
                world.add(
                    key(a),
                    *a.owner,
                    a.lamports(),
                    &a.try_borrow_data().unwrap(),
                );
            }
        }
        world.add(PROGRAM, solana_program::bpf_loader::id(), 1, &[]);
        world.get_mut(PROGRAM).set_executable(true);
        world.get_mut([0; 32]).set_owner(Pubkey::from_str_const(
            "NativeLoader1111111111111111111111111111111",
        ));
        world.get_mut([0; 32]).set_executable(true);
        world
    }
    fn add(&mut self, key: [u8; 32], owner: Pubkey, balance: u64, data: &[u8]) {
        assert!(!self.0.iter().any(|(k, _)| k.to_bytes() == key));
        self.0
            .push((Pubkey::new_from_array(key), literal(owner, balance, data)));
    }
    fn index(&self, key: [u8; 32]) -> usize {
        self.0
            .iter()
            .position(|(k, _)| k.to_bytes() == key)
            .unwrap()
    }
    fn get(&self, key: [u8; 32]) -> &AccountSharedData {
        &self.0[self.index(key)].1
    }
    fn get_mut(&mut self, key: [u8; 32]) -> &mut AccountSharedData {
        let i = self.index(key);
        &mut self.0[i].1
    }
    #[track_caller]
    fn run<F>(&mut self, roles: &[([u8; 32], bool, bool)], helper: F) -> rt::system_cpi::Output
    where
        F: for<'buffer, 'borrow> FnOnce(
            &'buffer Pubkey,
            &'borrow [AccountInfo<'buffer>],
            &'buffer [u8],
        )
            -> Result<(), solana_program::program_error::ProgramError>,
    {
        self.run_with_data(roles, &[], helper)
    }
    #[track_caller]
    fn run_with_data<F>(
        &mut self,
        roles: &[([u8; 32], bool, bool)],
        data: &[u8],
        helper: F,
    ) -> rt::system_cpi::Output
    where
        F: for<'buffer, 'borrow> FnOnce(
            &'buffer Pubkey,
            &'borrow [AccountInfo<'buffer>],
            &'buffer [u8],
        )
            -> Result<(), solana_program::program_error::ProgramError>,
    {
        let observed_clock = prologue::now().unwrap();
        let privileges = roles
            .iter()
            .map(|(k, s, w)| InstructionAccount::new(self.index(*k) as u16, *s, *w))
            .collect();
        let total = self
            .0
            .iter()
            .map(|(_, a)| a.lamports() as u128)
            .sum::<u128>();
        // SAFETY: only official ABI backing; each actual handler releases
        // borrows before CPI and no AccountInfo or reference escapes here.
        let out = unsafe {
            rt::system_cpi::run(
                self.0.clone(),
                self.index(PROGRAM) as u16,
                privileges,
                data.to_vec(),
                helper,
            )
        }
        .unwrap();
        assert_eq!(out.accounts.len(), self.0.len());
        assert_eq!(
            out.accounts
                .iter()
                .map(|a| a.lamports() as u128)
                .sum::<u128>(),
            total
        );
        for ((_, prior), next) in self.0.iter_mut().zip(&out.accounts) {
            *prior = next.clone();
        }
        self.1
            .push((observed_clock.ts, observed_clock.slot, out.logs.clone()));
        out
    }
    /// Feed the actual command bytes through the official serializer. Public
    /// dispatch must refuse without effects; only the private routing function
    /// is then exercised in this isolated unsigned harness. Probe contexts are
    /// disposable clones and are not successful gameplay calls in the trace.
    #[track_caller]
    fn run_expedition(
        &mut self,
        roles: &[([u8; 32], bool, bool)],
        data: &[u8],
    ) -> rt::system_cpi::Output {
        assert!(!expedition_exec::EXPEDITION_ENABLED);
        let mut probe = self.clone();
        let refused = probe.run_with_data(roles, data, |p, a, wire| {
            assert_eq!(
                crate::dispatch(p, a, wire),
                Err(FrontierError::NotImplemented.into()),
            );
            // Successful official writeback detects partial writes even when
            // the production handler returned an error.
            Ok(())
        });
        assert!(refused.logs.is_empty() && refused.cpis.is_empty());
        assert_eq!(probe.0, self.0);
        let mut extended = data.to_vec();
        extended.push(0);
        for malformed in [
            data[..data.len() - 1].to_vec(),
            extended,
            vec![
                wix::TAG_SETTLE_TICKET,
                wix::ENVELOPE_ESCAPE,
                wix::ENVELOPE_VERSION,
                wix::OP_RETURN,
            ],
        ] {
            let mut bad = self.clone();
            let out = bad.run_with_data(roles, &malformed, |p, a, wire| {
                let result = wix::WideCommand::decode(wire)
                    .map_err(crate::Error::from)
                    .and_then(|command| {
                        crate::proc::wide::dispatch_expedition_command(p, a, command)
                    });
                assert!(result.is_err());
                Ok(())
            });
            assert!(out.logs.is_empty() && out.cpis.is_empty());
            assert_eq!(bad.0, self.0);
        }
        self.run_with_data(roles, data, |p, a, wire| {
            let command = wix::WideCommand::decode(wire).map_err(crate::Error::from)?;
            crate::proc::wide::dispatch_expedition_command(p, a, command).map_err(Into::into)
        })
    }
    /// Exercise the existing isolated 60-byte resident contract without adding
    /// generic parser admission. Receipt inputs remain the decoded host bytes.
    #[track_caller]
    fn run_resident_draft(
        &mut self,
        roles: &[([u8; 32], bool, bool)],
        data: &[u8],
    ) -> rt::system_cpi::Output {
        use crate::proc::wide::expedition_resident;
        use frontier_abi::world_index::expedition_resident_ix as ix;
        assert_eq!(data.len(), ix::DRAFT_LEN);
        assert!(!expedition_exec::EXPEDITION_ENABLED);
        assert!(!ix::PUBLIC_DISPATCH_AVAILABLE);
        assert!(wix::WideCommand::decode(data).is_err());
        assert!(frontier_abi::v2::ix::tag_of(data).is_err());
        let mut wrapped = [0; 65];
        let n = wix::ResidentAct {
            generation: 1,
            inner: data,
        }
        .encode_into(&mut wrapped)
        .unwrap();
        assert!(wix::ResidentAct::decode(&wrapped[..n]).is_err());
        let mut probe = self.clone();
        let refused = probe.run_with_data(roles, data, |p, a, wire| {
            assert_eq!(
                crate::dispatch(p, a, wire),
                Err(FrontierError::BadData.into())
            );
            Ok(())
        });
        assert!(refused.logs.is_empty() && refused.cpis.is_empty());
        assert_eq!(probe.0, self.0);
        let mut malformed: Vec<Vec<u8>> = (0..data.len()).map(|n| data[..n].to_vec()).collect();
        let mut extended = data.to_vec();
        extended.push(0);
        malformed.push(extended);
        // Envelope tag/escape/version/op, host version, and world binding.
        for i in [0, 1, 2, 3, 4, 5] {
            let mut bytes = data.to_vec();
            bytes[i] ^= 0x80;
            malformed.push(bytes);
        }
        let mut other_action = data.to_vec();
        if data[0] == wix::TAG_DEPART {
            other_action[0] = wix::TAG_SETTLE_TICKET;
            other_action[3] = ix::RETURN_OP;
        } else {
            other_action[0] = wix::TAG_DEPART;
            other_action[3] = ix::DISSOLVE_OP;
        }
        malformed.push(other_action); // Valid command, wrong exact role count.
        let host = WideHostRef::from_bytes(&data[4..]).unwrap();
        let wrong_family = WideHostRef::new(
            ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap()),
            host.site(),
            host.gen(),
            host.seq(),
        )
        .unwrap();
        let mut wrong_host = data.to_vec();
        wrong_host[4..].copy_from_slice(&wrong_family.to_bytes());
        malformed.push(wrong_host);
        for bytes in malformed {
            let mut bad = self.clone();
            let out = bad.run_with_data(roles, &bytes, |p, a, wire| {
                assert!(expedition_resident::execute_draft(p, a, wire).is_err());
                Ok(())
            });
            assert!(out.logs.is_empty() && out.cpis.is_empty());
            assert_eq!(bad.0, self.0);
        }
        let season_index = if data[0] == wix::TAG_DEPART { 2 } else { 1 };
        let mut wrong_season = roles.to_vec();
        wrong_season[season_index] = *roles.last().unwrap();
        let mut extra_role = roles.to_vec();
        extra_role.push(*roles.last().unwrap());
        for wrong_roles in [roles[..roles.len() - 1].to_vec(), extra_role, wrong_season] {
            let mut bad = self.clone();
            let out = bad.run_with_data(&wrong_roles, data, |p, a, wire| {
                assert!(expedition_resident::execute_draft(p, a, wire).is_err());
                Ok(())
            });
            assert!(out.logs.is_empty() && out.cpis.is_empty());
            assert_eq!(bad.0, self.0);
        }
        let mut bad_program = self.clone();
        let out = bad_program.run_with_data(roles, data, |p, a, wire| {
            assert_ne!(p, a[season_index].key);
            assert!(expedition_resident::execute_draft(a[season_index].key, a, wire).is_err());
            Ok(())
        });
        assert!(out.logs.is_empty() && out.cpis.is_empty());
        assert_eq!(bad_program.0, self.0);
        self.run_with_data(roles, data, |p, a, wire| {
            expedition_resident::execute_draft(p, a, wire).map_err(Into::into)
        })
    }
}
fn r(k: [u8; 32]) -> ([u8; 32], bool, bool) {
    (k, false, false)
}
fn w(k: [u8; 32]) -> ([u8; 32], bool, bool) {
    (k, false, true)
}
fn payer() -> ([u8; 32], bool, bool) {
    (PAYER, true, true)
}

/// Reuse only the published IBE vector's symmetric material, in memory.
/// This deterministic test body provides no confidentiality or new timelock.
fn synthetic(plain: &WidePlain) -> ([u8; 32], [u8; wseal::WIDE_SEAL_LEN], [u8; 32]) {
    use crate::crypto::seal::tests::{cases, get};
    let vectors = include_bytes!("../../../permutation-rules/vectors/seal-vectors-v1.json");
    assert_eq!(
        xmd::sha256(&[vectors]),
        decode::<32>("9b93a9fb89e4c254942a78037210228ec91642f311b55cfefa076e5b9e294887")
    );
    let case = cases()
        .into_iter()
        .find(|c| get(c, "name") == "valid_spv2_32551361")
        .unwrap();
    assert_eq!(get(&case, "round").parse::<u64>().unwrap(), FIXTURE_ROUND);
    assert!(get(&case, "open_sig") == FIXTURE_SIG_HEX);
    assert!(quick::PK == quick::QUICKNET_PK);
    let verified = quick::verify(
        FIXTURE_ROUND,
        &decode::<48>(FIXTURE_SIG_HEX),
        &decode::<{ 2 * quick::HINT_LEN }>(FIXTURE_HINTS_HEX),
    )
    .unwrap();
    let legacy = decode::<{ cseal::SEAL_LEN }>(get(&case, "seal"));
    let ibe: [u8; cseal::IBE_LEN] = legacy[..cseal::IBE_LEN].try_into().unwrap();
    let recovered = cseal::recover_key(&verified, &ibe).unwrap();
    let salt = ks::salt_of(&recovered);
    let packed = wseal::pack(plain);
    let seal = wseal::assemble(&ibe, &wseal::body_xor(&recovered, &packed));
    (wseal::commit(&packed, &salt), seal, salt)
}

fn add_anchor_seed(
    world: &mut World,
    ctx: &AddrCtx,
    clock: &SeasonClock,
    bell: u32,
    region: u8,
    landed: i64,
) {
    let mut anchor = vec![0; K2::BellAnchor.size()];
    assert!(write_header(&mut anchor, K2::BellAnchor, SID));
    let mut a = Rw(&mut anchor);
    a.set_u32(BA::BELL, bell).unwrap();
    a.set_u8(BA::REGION, region).unwrap();
    a.set_u8(BA::NET, quick::NET_QUICKNET).unwrap();
    a.set_i64(BA::A, landed).unwrap();
    a.set_u64(BA::ROUND, clock.tlock_round(bell)).unwrap();
    a.set_u64(BA::SLOT, 76).unwrap();
    if bell == ARRIVE {
        a.set_arr(BA::SIG48, &decode::<48>(FIXTURE_SIG_HEX))
            .unwrap();
    }
    world.add(
        ctx.bell_anchor(bell, region),
        Pubkey::new_from_array(PROGRAM),
        1_000_000_000,
        &anchor,
    );
    let mut seed = vec![0; K2::SeedCache.size()];
    assert!(write_header(&mut seed, K2::SeedCache, SID));
    let mut s = Rw(&mut seed);
    s.set_u32(SC::BELL, bell).unwrap();
    s.set_u8(SC::REGION, region).unwrap();
    s.set_i64(SC::A, landed).unwrap();
    s.set_u64(SC::ROUND, clock.seed_round(bell, landed))
        .unwrap();
    s.set_arr(SC::ANCHOR_KEY, &ctx.bell_anchor(bell, region))
        .unwrap();
    s.set_arr(SC::SEED, &[0x5a; 32]).unwrap();
    world.add(
        ctx.seed_cache(bell, region, 0),
        Pubkey::new_from_array(PROGRAM),
        1_000_000_000,
        &seed,
    );
}

fn lifecycle(retreat_bps: u16, capture_after: bool) {
    lifecycle_with_resident_return(retreat_bps, capture_after, false);
}

fn lifecycle_with_resident_return(retreat_bps: u16, capture_after: bool, return_after: bool) {
    let (accounts, mut departure) = initial_fixture();
    let sk = key(&accounts[2]);
    let citizen = key(&accounts[3]);
    let hk = key(&accounts[4]);
    let home = key(&accounts[5]);
    let external = key(&accounts[8]);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let host = WideHostRef::from_bytes(&departure.host).unwrap();
    let (origin, target) = (0..61)
        .find_map(|local| {
            let border = WideTile::of(TileAddress::new(host.key(), local).unwrap());
            let next = border.neighbors()[0]?;
            let prev = border.neighbors()[3]?;
            (next.province_coord().ring() > 128 && prev.province() == host.key())
                .then_some((prev.address(), next.address()))
        })
        .unwrap();
    let plain = WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: ARRIVE,
        dest: target.key(),
        dest_tile: target.local(),
        stance: 0,
        retreat_bps,
        path_len: 2,
        path: [0; ks::PATH_BYTES],
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    let (commit, seal, salt) = synthetic(&plain);
    departure.commit = commit;
    departure.seal = seal;
    let mut world = World::from_infos(&accounts);
    let program = Pubkey::new_from_array(PROGRAM);
    // All direct byte edits below prepare the *initial* world, before departure.
    world.get_mut(external).set_lamports(0);
    {
        let mut sd = world.get(sk).data().to_vec();
        let mut s = Rw(&mut sd);
        s.set_i64(
            S::DRAND_GENESIS,
            permutation_rules::frontier::beacon::QUICKNET.genesis,
        )
        .unwrap();
        s.set_u32(S::DRAND_PERIOD, 3).unwrap();
        s.set_u32(S::REVEAL_WINDOW, 60).unwrap();
        s.set_u32(S::WINDOW_NEXT, 60).unwrap();
        s.set_u32(S::SEED_MARGIN, 60).unwrap();
        s.set_arr(SEASON_CQ_OFFSET, &FRONTIER_7.to_bytes()).unwrap();
        world.get_mut(sk).set_data_from_slice(&sd);
        let mut pd = world.get(home).data().to_vec();
        let mut e = read_entry(&pd, 0).unwrap();
        e.tile = origin.local();
        write_entry(&mut pd, 0, &e).unwrap();
        e.id = addr::host_id(128, 0, 1, 1, 0).unwrap();
        e.faction = 1;
        e.troops = 100_000;
        write_entry(&mut pd, 1, &e).unwrap();
        let mut p = Rw(&mut pd);
        p.set_u8(PV::N_ENTRIES, 2).unwrap();
        p.set_u16(PV::RING, 128).unwrap();
        p.set_u32(PV2::SCORE_NEXT_BELL, 10).unwrap();
        p.set_u64(PV::PASSABLE_MASK, (1u64 << 61) - 1).unwrap();
        p.set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1000).unwrap();
        write_no_keep(&mut pd).unwrap();
        world.get_mut(home).set_data_from_slice(&pd);
    }
    if capture_after {
        // Original home stock/cap are synthetic initial economic state.
        let mut hd = world.get(hk).data().to_vec();
        for i in 0..permutation_rules::frontier::holding::RESOURCES {
            Rw(&mut hd)
                .set_i64(
                    H::store(i) + frontier_abi::layout::player::accrual::VALUE,
                    1_000_000 * MILLI,
                )
                .unwrap();
            Rw(&mut hd)
                .set_i64(
                    H::store(i) + frontier_abi::layout::player::accrual::CAP,
                    2_000_000 * MILLI,
                )
                .unwrap();
        }
        world.get_mut(hk).set_data_from_slice(&hd);
    }
    let clock = SeasonClock::read(world.get(sk).data()).unwrap();
    assert_eq!(clock.tlock_round(ARRIVE), FIXTURE_ROUND);
    let region = permutation_rules::frontier::geometry::region_of(
        permutation_rules::frontier::geometry::ProvinceCoord::new(128, 0),
    );
    let ix = frontier_abi::prologue::ids::INSTRUCTIONS_SYSVAR;
    world.add(
        ix,
        Pubkey::from_str_const("Sysvar1111111111111111111111111111111111111"),
        1_000_000_000,
        &[0, 0, 0, 0],
    );
    add_anchor_seed(&mut world, &ctx, &clock, 10, region, GENESIS + 6600);
    add_anchor_seed(&mut world, &ctx, &clock, ARRIVE, 0, LANDED);
    let mut original_inputs = vec![0; K2::ClashInputs.size()];
    assert!(write_header(&mut original_inputs, K2::ClashInputs, SID));
    let mut c = Rw(&mut original_inputs);
    c.set_i16(CI::P, 128).unwrap();
    c.set_u32(CI::BELL, 10).unwrap();
    c.set_u32(CI::ARRIVALS_MASK, CI::ALL_GATHERED).unwrap();
    world.add(
        ctx.clash_inputs(128, 0, 10),
        program,
        1_000_000_000,
        &original_inputs,
    );
    let dest = target.key();
    let dest_key = wl::province_address(&ctx, dest.coord());
    let mut dp = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: SID,
        world: dest.world(),
        coord: dest.coord(),
        wedge: dest.coord().wedge().unwrap(),
        region: 0,
        opened_bell: 1,
        readiness: wl::readiness::REQUIRED,
        seed_round: 1,
        ring_seed: [0x81; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut dp)
    .unwrap();
    let mut d = Rw(&mut dp);
    d.set_u32(PV::RESOLVED_NEXT, ARRIVE).unwrap();
    d.set_u32(PV2::SCORE_NEXT_BELL, ARRIVE).unwrap();
    d.set_u64(PV::PASSABLE_MASK, (1u64 << 61) - 1).unwrap();
    d.set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1000).unwrap();
    write_no_keep(&mut dp).unwrap();
    if capture_after {
        dp[PV::SITE_COUNT] = 1;
        dp[PV::SITES] = target.local();
        dp[PV::site(0) + SM::STATE] = SM2::STATE_FREE_CITY;
        dp[PV::site(0) + SM::FACTION] = NEUTRAL;
    }
    let roster = WideRoster::new(SID, dest, PAYER);
    let mut rd = vec![0; wro::wide_roster::SIZE];
    roster.write_header(&mut rd).unwrap();
    let enemy = WideHostRef::new(dest, 1, 1, 3).unwrap();
    let alias = roster.claim(&mut rd, 0, &enemy).unwrap();
    write_entry(
        &mut dp,
        0,
        &Entry {
            id: alias,
            faction: 2,
            unit: 0,
            tile: target.local(),
            state: E::STATE_ROSTER,
            troops: 10_000,
            stamina_value: 120,
            stamina_bell: ARRIVE,
            ready_bell: ARRIVE,
            from_bell: 1,
            dealt_bps: 10_000,
            ..Entry::FREE
        },
    )
    .unwrap();
    Rw(&mut dp).set_u8(PV::N_ENTRIES, 1).unwrap();
    world.add(dest_key, program, 1_000_000_000, &dp);
    let roster_key = wro::roster_address(&ctx, dest);
    world.add(roster_key, program, 1_000_000_000, &rd);
    let inputs = wa::clash_inputs_address(&ctx, dest, ARRIVE);
    let day = wa::arrival_day_address(&ctx, dest, wa::day_of(ARRIVE));
    world.add(inputs, init::SYSTEM, 0, &[]);
    world.add(day, init::SYSTEM, 0, &[]);
    for k in 0..wa::wide_clash_inputs::POSITIONS {
        world.add(
            wa::arrival_slot_address(&ctx, dest, ARRIVE, (k / 4) as u8, (k % 4) as u8),
            init::SYSTEM,
            0,
            &[],
        );
    }
    let archive = ctx.anchor_archive(0, archive_part_of(ARRIVE));
    world.add(archive, init::SYSTEM, 0, &[]);
    let log = ctx.beacon_log(0);
    let mut ld = vec![0; K2::BeaconLog.size()];
    assert!(write_header(&mut ld, K2::BeaconLog, SID));
    Rw(&mut ld)
        .set_u64(BL::LATEST_ROUND, clock.tlock_round(ARRIVE))
        .unwrap();
    world.add(log, program, 1_000_000_000, &ld);
    world.add([90; 32], init::SYSTEM, 1_000_000_000, &[]);
    world.add([91; 32], init::SYSTEM, 1_000_000_000, &[]);
    if capture_after {
        use frontier_abi::world_index::conquest as wc;
        world.add(wc::conquest_address(&ctx, dest), init::SYSTEM, 0, &[]);
        world.add(
            wc::capture_escrow_address(&ctx, &citizen),
            init::SYSTEM,
            0,
            &[],
        );
        world.add(
            wh::holding_address(&ctx, dest.coord(), 0),
            init::SYSTEM,
            0,
            &[],
        );
        let mut shard = vec![0; K2::JoinShard.size()];
        assert!(write_header(&mut shard, K2::JoinShard, SID));
        world.add(ctx.join_shard(0, 0), program, 1_000_000_000, &shard);
        // Immutable future beacon inputs are explicit prior state, all present
        // before departure. Every intervening conquest bell runs its handler.
        for bell in 13..=64 {
            add_anchor_seed(
                &mut world,
                &ctx,
                &clock,
                bell,
                0,
                GENESIS + (bell as i64 + 1) * 600,
            );
            world.add(
                wa::clash_inputs_address(&ctx, dest, bell),
                init::SYSTEM,
                0,
                &[],
            );
        }
    }
    // No initial-world account bytes or balances are edited after this point.
    let initial_citizen = world.get(citizen).data().to_vec();
    let initial_holding_balance = world.get(hk).lamports();
    prologue::set_test_clock(NOW, 1);
    let departed = world.run_expedition(
        &[
            (WALLET, true, false),
            payer(),
            r(sk),
            w(citizen),
            w(hk),
            w(home),
            r([0; 32]),
            w(home),
            w(external),
        ],
        &departure.to_bytes(),
    );
    assert_eq!(departed.cpis.len(), 3);
    assert_eq!(
        world.get(hk).lamports(),
        initial_holding_balance + departure.tip
    );
    assert_eq!(world.get(external).owner(), &program);
    assert_eq!(
        OwnedBridgeTransit::from_bytes(&ctx, world.get(external).data())
            .unwrap()
            .transit()
            .state,
        MarchState::Departed
    );
    assert_eq!(
        &world.get(citizen).data()[C2::holding_of_slot(1)..C2::holding_of_slot(1) + 6],
        &initial_citizen[C2::holding_of_slot(1)..C2::holding_of_slot(1) + 6]
    );

    prologue::set_test_clock(GENESIS + 6720, 2000);
    let resolved = world.run(
        &[
            payer(),
            r(sk),
            w(home),
            w(ctx.clash_inputs(128, 0, 10)),
            r(ctx.seed_cache(10, region, 0)),
            r(ctx.bell_anchor(10, region)),
            r(ix),
        ],
        |p, a, _| {
            crate::proc::clash::resolve_from_inputs(
                p,
                a,
                &frontier_abi::ix::ResolveFromInputs {
                    bell: 10,
                    beneficiary: PAYER,
                }
                .to_bytes(),
            )
            .map_err(Into::into)
        },
    );
    assert!(resolved.cpis.is_empty());
    let survivor = read_entry(world.get(home).data(), 0).unwrap();
    assert_eq!(survivor.state, E::STATE_DEPARTED);
    assert!(survivor.troops > 0 && survivor.troops < 200_000);
    let origin_done = world.run_expedition(
        &[payer(), r(sk), w(home), w(hk), w(home), w(external)],
        &wix::ExpeditionSettleOrigin { transit_slot: 0 }.to_bytes(),
    );
    assert!(origin_done.cpis.is_empty());
    assert_eq!(read_entry(world.get(home).data(), 0).unwrap(), Entry::FREE);
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, world.get(external).data()).unwrap();
    assert_eq!(bridge.transit().troops_after, survivor.troops);
    assert_eq!(bridge.original_owner(), citizen);
    assert_eq!(bridge.transit().state, MarchState::Settled);

    prologue::set_test_clock(LANDED + 1, 3000);
    let slot = wa::arrival_slot_address(&ctx, dest, ARRIVE, 0, 0);
    let reveal = wix::ExpeditionReveal {
        transit_slot: 0,
        target_i: 0,
        plain: wseal::pack(&plain),
        salt,
        ct_hash: wseal::ct_hash(&seal),
        beneficiary: PAYER,
    };
    let revealed = world.run_expedition(
        &[
            payer(),
            r(sk),
            r(hk),
            r(external),
            r(ctx.bell_anchor(ARRIVE, 0)),
            r(archive),
            r(log),
            r(inputs),
            r(dest_key),
            w(day),
            w(slot),
            r(wa::arrival_slot_address(&ctx, dest, ARRIVE, 0, 1)),
            r(wa::arrival_slot_address(&ctx, dest, ARRIVE, 0, 2)),
            r(wa::arrival_slot_address(&ctx, dest, ARRIVE, 0, 3)),
            r(ix),
            r([0; 32]),
            r(home),
        ],
        &reveal.to_bytes(),
    );
    assert_eq!(revealed.cpis.len(), 4);
    assert_eq!(world.get(day).owner(), &program);
    assert_eq!(world.get(slot).owner(), &program);
    let admission = ExpeditionArrivalSlot::read(&ctx, world.get(slot).data()).unwrap();
    assert_eq!(admission.common().host, host);
    assert_eq!(admission.common().citizen, citizen);
    assert_eq!(admission.common().dep_mass, 200_000);
    let wear = admission.worn_bps();
    prologue::set_test_clock(clock.round_time(clock.seed_round(ARRIVE, LANDED)), 4000);
    let mut gather_roles = vec![
        payer(),
        r(sk),
        r(dest_key),
        r(ctx.bell_anchor(ARRIVE, 0)),
        w(inputs),
        r(day),
        r(ix),
        r([0; 32]),
    ];
    for k in 0..wa::wide_clash_inputs::POSITIONS {
        gather_roles.push(r(wa::arrival_slot_address(
            &ctx,
            dest,
            ARRIVE,
            (k / 4) as u8,
            (k % 4) as u8,
        )));
        gather_roles.push(if k == 0 { r(hk) } else { r(WALLET) });
        gather_roles.push(if k == 0 { w(external) } else { r(WALLET) });
    }
    let gather = wix::ExpeditionGather {
        bell: ARRIVE,
        start: 0,
        n: wa::wide_clash_inputs::POSITIONS as u8,
    };
    let gathered = world.run_expedition(&gather_roles, &gather.to_bytes());
    assert_eq!(gathered.cpis.len(), 2);
    assert_eq!(world.get(inputs).owner(), &program);
    let header = WideClashInputsHdr::read(world.get(inputs).data()).unwrap();
    assert_eq!(header.arrivals_mask, wa::wide_clash_inputs::ALL_GATHERED);
    assert_eq!(header.n_present, 1);
    let row = WideArrival::read_at(world.get(inputs).data(), 0)
        .unwrap()
        .unwrap();
    assert_eq!(row.host, host);
    assert_eq!(row.citizen, citizen);
    assert_eq!(
        row.troops,
        permutation_rules::frontier::structure::wear(survivor.troops as u64, wear) as u32
    );
    assert_eq!(row.dep_mass, 200_000);
    assert_eq!(
        OwnedBridgeTransit::from_bytes(&ctx, world.get(external).data())
            .unwrap()
            .transit()
            .state,
        MarchState::Gathered
    );
    let before_repeat = world.0.clone();
    let repeat = world.run_expedition(&gather_roles, &gather.to_bytes());
    assert!(repeat.cpis.is_empty());
    assert_eq!(world.0, before_repeat);
    let combat = world.run(
        &[
            payer(),
            r(sk),
            w(dest_key),
            w(roster_key),
            r(ctx.seed_cache(ARRIVE, 0, 0)),
            r(ctx.bell_anchor(ARRIVE, 0)),
            w(inputs),
            r(day),
            r([0; 32]),
        ],
        |p, a, _| {
            crate::proc::wide::resolve(
                p,
                a,
                &wix::Resolve {
                    bell: ARRIVE,
                    beneficiary: PAYER,
                },
            )
            .map_err(Into::into)
        },
    );
    assert!(combat.cpis.is_empty());
    let after = WideArrival::read_at(world.get(inputs).data(), 0)
        .unwrap()
        .unwrap();
    assert_eq!(after.host, host);
    assert_eq!(after.citizen, citizen);
    if retreat_bps == 0 {
        assert!(after.troops_after > 0 && after.troops_after < row.troops);
        assert_eq!(after.fate, wa::wide_arrival::FATE_STAYS);
        assert!(
            Ro(world.get(dest_key).data())
                .u32(PV::RESOLVE_SUMMARY + SU::ENGAGEMENTS)
                .unwrap()
                > 0
        );
    } else {
        assert_eq!(after.troops_after, row.troops);
        assert_eq!(after.fate, wa::wide_arrival::FATE_RETREATED);
    }
    let roster = WideRoster::read(world.get(roster_key).data()).unwrap();
    let live = roster.table(world.get(roster_key).data()).unwrap();
    assert_eq!(live.iter().any(|(_, _, h)| *h == host), retreat_bps == 0);
    assert_eq!(live.iter().any(|(_, _, h)| *h == enemy), retreat_bps != 0);
    let home_before_return = world.get(home).data().to_vec();
    prologue::set_test_clock(
        clock.reveal_close(ARRIVE, LANDED) + crate::proc::transit::SETTLE_AFTER_CLOSE_SECS,
        5000,
    );
    let settlement_roles = [
        r(sk),
        w(hk),
        w(external),
        w(home),
        w(dest_key),
        w(inputs),
        w(slot),
        w(PAYER),
        r(ctx.bell_anchor(ARRIVE, 0)),
        ([90; 32], true, true),
        w(PAYER),
        w(PAYER),
        w(WALLET),
        w([91; 32]),
    ];
    let settled = world.run(&settlement_roles, |p, a, _| {
        crate::proc::wide::expedition_return::runtime_settle(p, a, 8, 0, &commit, &seal)
            .map_err(Into::into)
    });
    assert!(settled.cpis.is_empty());
    assert_eq!(Ro(world.get(hk).data()).u64(H::ESCROW).unwrap(), 0);
    assert!(
        world.get(hk).data()[H::transit(0)..H::transit(0) + MARKER_LEN]
            .iter()
            .all(|b| *b == 0)
    );
    assert_eq!(world.get(external).owner(), &init::SYSTEM);
    assert_eq!(world.get(external).lamports(), 0);
    assert!(world.get(external).data().is_empty());
    assert_ne!(
        WideClashInputsHdr::read(world.get(inputs).data())
            .unwrap()
            .settled_mask
            & 1,
        0
    );
    assert_eq!(world.get(slot).owner(), &init::SYSTEM);
    assert_eq!(world.get(slot).lamports(), 0);
    assert!(world.get(slot).data().is_empty());
    assert_eq!(settled.logs.len(), 2);
    let original = frontier_abi::world_index::expedition_settlement_event::Record::decode(
        &ctx,
        &settled.logs[0][1],
    )
    .unwrap();
    let wide = frontier_abi::world_index::expedition_settlement_event::Record::decode(
        &ctx,
        &settled.logs[1][1],
    )
    .unwrap();
    original.pair(&wide).unwrap();
    if retreat_bps == 0 {
        assert_eq!(world.get(home).data(), home_before_return);
    } else {
        let returned = read_entry(world.get(home).data(), 0).unwrap();
        assert_eq!(returned.id, addr::host_id(128, 0, 0, 1, 0).unwrap());
        assert_eq!(returned.troops, after.troops_after);
        assert_eq!(returned.state, E::STATE_MUSTER_PENDING);
        assert_eq!(Ro(world.get(hk).data()).u32(H::HOST_SEQ).unwrap(), 1);
    }
    let settled_snapshot = world.0.clone();
    let privileges = settlement_roles
        .iter()
        .map(|(k, s, w)| InstructionAccount::new(world.index(*k) as u16, *s, *w))
        .collect();
    // SAFETY: identical bounded, audited callback and official ABI contract.
    // Failure isolation is checked, not a claim of bank rollback.
    let replay = unsafe {
        rt::system_cpi::run(
            world.0.clone(),
            world.index(PROGRAM) as u16,
            privileges,
            vec![],
            |p, a, _| {
                crate::proc::wide::expedition_return::runtime_settle(p, a, 8, 0, &commit, &seal)
                    .map_err(Into::into)
            },
        )
    };
    assert!(matches!(replay, Err(rt::RunError::Helper(_))));
    assert_eq!(world.0, settled_snapshot);
    if capture_after {
        capture_continuation(
            &mut world, &ctx, &clock, sk, citizen, hk, home, dest, dest_key, roster_key, day, host,
        );
        if return_after {
            resident_return_continuation(
                &mut world, &ctx, &clock, sk, citizen, hk, home, dest, dest_key, roster_key, day,
                host,
            );
            anchor_boundary_trace(&world, sk);
        }
    }
    assert!(!expedition_exec::EXPEDITION_ENABLED);
}

#[test]
fn contiguous_departure_boundary_combat_and_stays_settlement() {
    lifecycle(0, false);
}

#[test]
fn contiguous_departure_boundary_retreat_and_original_home_return() {
    lifecycle(1, false);
}

/// Starts with the actual arrived/staying host, then runs every declaration,
/// siege bell and allocation. No roster admission or capture mirror injection.
#[allow(clippy::too_many_arguments)]
fn capture_continuation(
    world: &mut World,
    ctx: &AddrCtx,
    clock: &SeasonClock,
    sk: [u8; 32],
    citizen: [u8; 32],
    source: [u8; 32],
    home: [u8; 32],
    dest: ProvinceKey,
    province: [u8; 32],
    roster_key: [u8; 32],
    day: [u8; 32],
    host: WideHostRef,
) {
    use crate::proc::wide::{conquest_exec, conquest_settle_exec};
    use frontier_abi::conquest_model::Record;
    use frontier_abi::v2::layout::province::conquest as CR;
    use frontier_abi::world_index::{conquest as wc, legacy_source_event as le};
    let table = wc::conquest_address(ctx, dest);
    let escrow = wc::capture_escrow_address(ctx, &citizen);
    let target = wh::holding_address(ctx, dest.coord(), 0);
    let shard = ctx.join_shard(0, 0);
    let home_binding = wh::binding_of(world.get(citizen).data(), 1).unwrap();
    let source_chain = crate::layout::chain_of(world.get(source).data()).unwrap();
    let declared_bell = clock.bell_at(prologue::now().unwrap().ts).unwrap();
    // Catch up the actual province before declaring. A prior bell must not be
    // skipped by inserting a current-bell siege into its historical state.
    let cursor = Ro(world.get(province).data())
        .u32(PV::RESOLVED_NEXT)
        .unwrap();
    for bell in cursor..declared_bell {
        let out = world.run(
            &[
                payer(),
                r(sk),
                w(province),
                w(roster_key),
                r(ctx.seed_cache(bell, 0, 0)),
                r(ctx.bell_anchor(bell, 0)),
                w(wa::clash_inputs_address(ctx, dest, bell)),
                r(day),
                r([0; 32]),
            ],
            |p, a, _| {
                crate::proc::wide::resolve(
                    p,
                    a,
                    &wix::Resolve {
                        bell,
                        beneficiary: PAYER,
                    },
                )
                .map_err(Into::into)
            },
        );
        assert!(out.cpis.is_empty());
    }
    let roster = WideRoster::read(world.get(roster_key).data()).unwrap();
    let (index, _, found) = roster
        .table(world.get(roster_key).data())
        .unwrap()
        .into_iter()
        .find(|(_, _, h)| *h == host)
        .unwrap();
    assert_eq!(found, host);
    let declared = world.run(
        &[
            (WALLET, true, false),
            payer(),
            r(sk),
            w(citizen),
            w(source),
            w(province),
            r(roster_key),
            r(home),
            r(target),
            w(table),
            w(escrow),
            r([0; 32]),
        ],
        |p, a, _| {
            conquest_exec::runtime_declare(
                p,
                a,
                &wix::DeclareSiege {
                    site: 0,
                    entry: index as u8,
                },
            )
            .map_err(Into::into)
        },
    );
    assert_eq!(declared.cpis.len(), 5);
    let required = Record::read(world.get(province).data(), 0)
        .unwrap()
        .required as u32;
    assert_eq!(
        required,
        permutation_rules::frontier::siege::required_bells(0, 0)
    );
    assert_eq!(world.get(table).owner().to_bytes(), PROGRAM);
    assert_eq!(world.get(escrow).owner().to_bytes(), PROGRAM);
    assert_eq!(
        wc::WideCaptureEscrow::read(world.get(escrow).data(), SID, dest.world(), citizen)
            .unwrap()
            .active_mask(),
        C2::reserved_bit(2)
    );
    assert_eq!(world.get(target).owner(), &init::SYSTEM);
    let start = Ro(world.get(province).data())
        .u32(PV::RESOLVED_NEXT)
        .unwrap();
    for bell in start..=declared_bell + required {
        let landed = GENESIS + (bell as i64 + 1) * 600;
        prologue::set_test_clock(
            clock.round_time(clock.seed_round(bell, landed)),
            6000 + bell as u64,
        );
        let out = world.run(
            &[
                payer(),
                r(sk),
                w(province),
                w(roster_key),
                r(ctx.seed_cache(bell, 0, 0)),
                r(ctx.bell_anchor(bell, 0)),
                w(wa::clash_inputs_address(ctx, dest, bell)),
                r(day),
                r([0; 32]),
                w(table),
            ],
            |p, a, _| {
                let result = conquest_exec::runtime_resolve(
                    p,
                    a,
                    &wix::ResolveWithConquest {
                        bell,
                        beneficiary: PAYER,
                    },
                );
                assert!(result.is_ok(), "siege resolve bell {bell}: {result:?}");
                result.map_err(Into::into)
            },
        );
        assert!(out.cpis.is_empty());
        assert_eq!(
            Ro(world.get(province).data())
                .u32(PV::RESOLVED_NEXT)
                .unwrap(),
            bell + 1
        );
    }
    let due = Record::read(world.get(province).data(), 0).unwrap();
    assert_eq!(due.kind, CR::KIND_CAPTURE_DUE);
    assert_eq!(due.bell, declared_bell + required);
    let capture_roles = [
        payer(),
        r(sk),
        w(province),
        w(table),
        w(citizen),
        w(shard),
        w(escrow),
        w(target),
        w(source),
        r([0; 32]),
    ];
    let captured = world.run(&capture_roles, |p, a, _| {
        conquest_settle_exec::runtime_capture(p, a, &wix::SettleCapture { site: 0 })
            .map_err(Into::into)
    });
    assert_eq!(captured.cpis.len(), 1);
    assert_eq!(
        u32::from_le_bytes(captured.cpis[0].data[..4].try_into().unwrap()),
        9
    );
    let h = WideHolding::read(world.get(target).data()).unwrap();
    assert_eq!(
        (h.owner_citizen, h.coord, h.site, h.gen, h.slot),
        (citizen, dest.coord(), 0, 1, 2)
    );
    assert_eq!(
        world.get(target).lamports(),
        init::rent(wh::wide_holding::SIZE).unwrap()
    );
    assert_eq!(
        wh::binding_of(world.get(citizen).data(), 1).unwrap(),
        home_binding
    );
    assert_eq!(
        wh::binding_of(world.get(citizen).data(), 2).unwrap(),
        wh::SlotBinding::Wide
    );
    assert_eq!(world.get(citizen).data()[C2::HOLDINGS_N], 2);
    assert_eq!(
        wc::wide_reservations(world.get(citizen).data()[C2::SLOTS]).unwrap(),
        0
    );
    assert_eq!(
        Ro(world.get(shard).data())
            .u32(JS2::EXTRA_HOLDINGS)
            .unwrap(),
        1
    );
    assert_eq!(world.get(source).data().len(), K2::Holding.size());
    assert_eq!(Ro(world.get(source).data()).u32(H::HOST_SEQ).unwrap(), 1);
    let resolver = AccountResolver::for_season(ctx).unwrap();
    let mut previous = source_chain;
    for (output, direction) in [
        (&declared, le::Direction::Debit),
        (&captured, le::Direction::Credit),
    ] {
        let record = output
            .logs
            .iter()
            .find(|fields| fields[0] == le::PREFIX)
            .unwrap();
        let record = le::Record::decode(&resolver, &record[1]).unwrap();
        record
            .verify_previous(&resolver, previous.0, &previous.1)
            .unwrap();
        assert_eq!(record.source.direction, direction);
        assert_eq!(record.source.source_address, source);
        previous = (record.link.seq, record.link.head);
    }
    assert_eq!(
        crate::layout::chain_of(world.get(source).data()).unwrap(),
        previous
    );
    let before = world.0.clone();
    let privileges = capture_roles
        .iter()
        .map(|(k, s, w)| InstructionAccount::new(world.index(*k) as u16, *s, *w))
        .collect();
    // SAFETY: same bounded real handler and official serializer as above.
    let repeated = unsafe {
        rt::system_cpi::run(
            world.0.clone(),
            world.index(PROGRAM) as u16,
            privileges,
            vec![],
            |p, a, _| {
                conquest_settle_exec::runtime_capture(p, a, &wix::SettleCapture { site: 0 })
                    .map_err(Into::into)
            },
        )
    };
    assert!(matches!(repeated, Err(rt::RunError::Helper(_))));
    assert_eq!(world.0, before);
    assert!(!crate::proc::wide::CONQUEST_LIFECYCLE_ENABLED);
}

#[test]
fn contiguous_original_departure_boundary_combat_and_free_city_capture() {
    lifecycle(0, true);
}

/// Capture is already settled and the same original host is resident wide.
/// Dissolve and the following real Resolve produce the returnable Leave row.
#[allow(clippy::too_many_arguments)]
fn resident_return_continuation(
    world: &mut World,
    ctx: &AddrCtx,
    clock: &SeasonClock,
    sk: [u8; 32],
    citizen: [u8; 32],
    source: [u8; 32],
    home: [u8; 32],
    dest: ProvinceKey,
    province: [u8; 32],
    roster_key: [u8; 32],
    day: [u8; 32],
    host: WideHostRef,
) {
    use crate::proc::wide::{conquest_exec, expedition_resident};
    use frontier_abi::world_index::conquest as wc;
    use frontier_abi::world_index::expedition_resident_ix as resident_ix;
    let target = wh::holding_address(ctx, dest.coord(), 0);
    let captured_holding = world.get(target).clone();
    let original_home = world.get(home).clone();
    let bell = clock.bell_at(prologue::now().unwrap().ts).unwrap();
    let dissolve_roles = [
        (WALLET, true, false),
        payer(),
        r(sk),
        w(citizen),
        w(source),
        w(province),
        r(roster_key),
        r(home),
    ];
    let return_roles = [
        payer(),
        r(sk),
        w(province),
        w(roster_key),
        w(source),
        r(home),
    ];
    let reject = |world: &World,
                  roles: &[([u8; 32], bool, bool)],
                  dissolve: bool,
                  tested_host: WideHostRef| {
        let privileges = roles
            .iter()
            .map(|(k, s, w)| InstructionAccount::new(world.index(*k) as u16, *s, *w))
            .collect();
        let command = resident_ix::DraftCommand::new(
            ctx,
            if dissolve {
                resident_ix::Action::Dissolve
            } else {
                resident_ix::Action::Return
            },
            tested_host,
        )
        .unwrap()
        .to_bytes();
        // SAFETY: same fixed original-family handlers, official backing, no CPI.
        let result = unsafe {
            rt::system_cpi::run(
                world.0.clone(),
                world.index(PROGRAM) as u16,
                privileges,
                command.to_vec(),
                |p, a, wire| {
                    let refusal = expedition_resident::execute_draft(p, a, wire);
                    assert!(refusal.is_err());
                    // Permit official writeback after the expected refusal.
                    // This detects partial effects instead of discarding them.
                    Ok(())
                },
            )
        }
        .unwrap();
        assert!(result.logs.is_empty());
        assert!(result.cpis.is_empty());
        assert_eq!(
            result.accounts,
            world.0.iter().map(|(_, a)| a.clone()).collect::<Vec<_>>()
        );
    };
    reject(world, &return_roles, false, host); // A resident cannot return before Leave.
    let mut bad_signer = dissolve_roles;
    bad_signer[0].1 = false;
    reject(world, &bad_signer, true, host);
    let mut readonly_source = dissolve_roles;
    readonly_source[4].2 = false;
    reject(world, &readonly_source, true, host);
    let wrong_generation =
        WideHostRef::new(host.key(), host.site(), host.gen() + 1, host.seq()).unwrap();
    reject(world, &dissolve_roles, true, wrong_generation);
    let mut locked = world.clone();
    let mut locked_home = locked.get(home).data().to_vec();
    locked_home[PV::site(host.site() as usize) + SM::STATE] = SM::STATE_HOLDING;
    locked_home[PV::site(host.site() as usize) + SM::GEN] = host.gen() + 1;
    locked.get_mut(home).set_data_from_slice(&locked_home);
    reject(&locked, &dissolve_roles, true, host);
    let before_dissolve = world.clone();
    let dissolve_now = prologue::now().unwrap();
    let dissolved = world.run_resident_draft(
        &dissolve_roles,
        &resident_ix::DraftCommand::new(ctx, resident_ix::Action::Dissolve, host)
            .unwrap()
            .to_bytes(),
    );
    verify_resident_receipts(
        ctx,
        &before_dissolve,
        world,
        &dissolved,
        frontier_abi::world_index::expedition_resident_event::Action::Dissolve,
        host,
    );
    anchor_resident_fixture(
        &before_dissolve,
        world,
        &dissolve_roles,
        &dissolved,
        frontier_abi::world_index::expedition_resident_event::Action::Dissolve,
        sk,
        host,
        dissolve_now,
    );
    assert!(dissolved.cpis.is_empty());
    assert_eq!(dissolved.logs.len(), 2);
    reject(world, &dissolve_roles, true, host); // One pending operation per host.
    reject(world, &return_roles, false, host); // Actual clash still has to resolve.
    let roster = WideRoster::read(world.get(roster_key).data()).unwrap();
    let (index, _, _) = roster
        .table(world.get(roster_key).data())
        .unwrap()
        .into_iter()
        .find(|(_, _, h)| *h == host)
        .unwrap();
    let pending = read_entry(world.get(province).data(), index).unwrap();
    assert!(matches!(pending.op, EntryOp::Leave));
    assert_eq!((pending.state, pending.pend_bell), (E::STATE_ROSTER, bell));
    let cursor = Ro(world.get(province).data())
        .u32(PV::RESOLVED_NEXT)
        .unwrap();
    for resolved in cursor..=bell {
        let landed = GENESIS + (resolved as i64 + 1) * 600;
        prologue::set_test_clock(
            clock.round_time(clock.seed_round(resolved, landed)),
            7000 + resolved as u64,
        );
        let output = world.run(
            &[
                payer(),
                r(sk),
                w(province),
                w(roster_key),
                r(ctx.seed_cache(resolved, 0, 0)),
                r(ctx.bell_anchor(resolved, 0)),
                w(wa::clash_inputs_address(ctx, dest, resolved)),
                r(day),
                r([0; 32]),
                w(wc::conquest_address(ctx, dest)),
            ],
            |p, a, _| {
                conquest_exec::runtime_resolve(
                    p,
                    a,
                    &wix::ResolveWithConquest {
                        bell: resolved,
                        beneficiary: PAYER,
                    },
                )
                .map_err(Into::into)
            },
        );
        assert!(output.cpis.is_empty());
    }
    let departed = read_entry(world.get(province).data(), index).unwrap();
    assert_eq!(departed.state, E::STATE_DEPARTED);
    assert!(matches!(departed.op, EntryOp::Leave));
    assert!(departed.troops > 0);
    let old_reserve = Ro(world.get(source).data())
        .u32(H::reserve(departed.unit as usize))
        .unwrap();
    let citizen_before_return = world.get(citizen).clone();
    // Adversarial overflow is isolated to a rejected clone, never fed back
    // into the contiguous successful world or used as an outcome.
    let mut overflowing = world.clone();
    let mut overflow_source = overflowing.get(source).data().to_vec();
    Rw(&mut overflow_source)
        .set_u32(H::reserve(departed.unit as usize), u32::MAX)
        .unwrap();
    overflowing
        .get_mut(source)
        .set_data_from_slice(&overflow_source);
    reject(&overflowing, &return_roles, false, host);
    reject(world, &return_roles, false, wrong_generation);
    let mut return_locked = world.clone();
    return_locked
        .get_mut(home)
        .set_data_from_slice(&locked_home);
    reject(&return_locked, &return_roles, false, host);
    // Generic Entry decoding omits raw retire/donor payload. A bounded
    // voluntary-return candidate must refuse every such payload component.
    for offset in [E::OP_A, E::OP_B, E::OP_TROOPS, E::OP_REF] {
        let mut redirected = world.clone();
        let mut redirected_province = redirected.get(province).data().to_vec();
        redirected_province[PV::entry(index) + offset] = 1;
        redirected
            .get_mut(province)
            .set_data_from_slice(&redirected_province);
        reject(&redirected, &return_roles, false, host);
    }
    let mut retired = world.clone();
    let mut retired_province = retired.get(province).data().to_vec();
    let raw = PV::entry(index);
    retired_province[raw + E::OP_A] = frontier_abi::v2::entry::RETIRE_OP_A;
    let home_ref = (frontier_abi::addr::host_id(127, 0, 0, 1, 0).unwrap() >> 32) as u32;
    Rw(&mut retired_province)
        .set_u32(raw + E::OP_REF, home_ref)
        .unwrap();
    assert!(
        crate::proc::host::return_target(
            frontier_abi::world_index::expedition::AccountResolver::for_season(ctx)
                .unwrap()
                .legacy_host_id(&host)
                .unwrap(),
            frontier_abi::v2::entry::RETIRE_OP_A,
            home_ref,
        )
        .bound
    );
    retired
        .get_mut(province)
        .set_data_from_slice(&retired_province);
    reject(&retired, &return_roles, false, host);
    let before_return = world.clone();
    let return_now = prologue::now().unwrap();
    let returned = world.run_resident_draft(
        &return_roles,
        &resident_ix::DraftCommand::new(ctx, resident_ix::Action::Return, host)
            .unwrap()
            .to_bytes(),
    );
    verify_resident_receipts(
        ctx,
        &before_return,
        world,
        &returned,
        frontier_abi::world_index::expedition_resident_event::Action::Return,
        host,
    );
    anchor_resident_fixture(
        &before_return,
        world,
        &return_roles,
        &returned,
        frontier_abi::world_index::expedition_resident_event::Action::Return,
        sk,
        host,
        return_now,
    );
    assert!(returned.cpis.is_empty());
    assert_eq!(returned.logs.len(), 2);
    assert_eq!(
        Ro(world.get(source).data())
            .u32(H::reserve(departed.unit as usize))
            .unwrap(),
        old_reserve + departed.troops / MILLI as u32
    );
    assert_eq!(
        read_entry(world.get(province).data(), index).unwrap(),
        Entry::FREE
    );
    assert!(roster
        .ref_at(world.get(roster_key).data(), index)
        .unwrap()
        .is_none());
    assert_eq!(Ro(world.get(source).data()).u32(H::HOST_SEQ).unwrap(), 1);
    assert_eq!(world.get(target), &captured_holding);
    assert_eq!(world.get(home), &original_home);
    assert_eq!(world.get(citizen), &citizen_before_return);
    reject(world, &return_roles, false, host);
}

#[test]
fn contiguous_original_boundary_capture_and_resident_home_return() {
    lifecycle_with_resident_return(0, true, true);
}

/// Byte-exact native provenance for the independent verifier's immutable input.
/// BRESv001, action, program, season, host, pre-handler timestamp/slot, role count,
/// all before roles, all after roles, then the two actual emitted receipt bodies.
/// Each role carries address/owner/presence/signer/writable/executable, lamports,
/// and u32-length-prefixed data. Integer fields are little-endian.
#[allow(clippy::too_many_arguments)]
fn anchor_resident_fixture(
    before: &World,
    after: &World,
    roles: &[([u8; 32], bool, bool)],
    output: &rt::system_cpi::Output,
    action: frontier_abi::world_index::expedition_resident_event::Action,
    season: [u8; 32],
    host: WideHostRef,
    now: prologue::Now,
) {
    use frontier_abi::world_index::expedition_resident_event as re;
    assert!(output.cpis.is_empty());
    assert_eq!(output.logs.len(), 2);
    assert_eq!(output.logs[0].len(), 2);
    assert_eq!(output.logs[1].len(), 2);
    assert_eq!(output.logs[0][0], frontier_abi::log::PREFIX);
    assert_eq!(output.logs[1][0], wev::WIDE_LOG_PREFIX);
    let mut bytes = b"BRESv001".to_vec();
    bytes.push(match action {
        re::Action::Dissolve => 1,
        re::Action::Return => 2,
    });
    bytes.extend_from_slice(&PROGRAM);
    bytes.extend_from_slice(&season);
    bytes.extend_from_slice(&host.to_bytes());
    bytes.extend_from_slice(&now.ts.to_le_bytes());
    bytes.extend_from_slice(&now.slot.to_le_bytes());
    bytes.push(u8::try_from(roles.len()).unwrap());
    for world in [before, after] {
        for (address, signer, writable) in roles {
            // The official adapter rejects conflicting duplicate privileges.
            // These are consequently the effective AccountInfo flags as well.
            assert!(roles
                .iter()
                .all(|(other, s, w)| { other != address || (s == signer && w == writable) }));
            let account = world.get(*address);
            bytes.extend_from_slice(address);
            bytes.extend_from_slice(&account.owner().to_bytes());
            bytes.push(u8::from(
                !(account.owner() == &init::SYSTEM && account.data().is_empty()),
            ));
            bytes.push(u8::from(*signer));
            bytes.push(u8::from(*writable));
            bytes.push(u8::from(account.executable()));
            bytes.extend_from_slice(&account.lamports().to_le_bytes());
            bytes.extend_from_slice(&u32::try_from(account.data().len()).unwrap().to_le_bytes());
            bytes.extend_from_slice(account.data());
        }
    }
    bytes.push(2);
    for fields in &output.logs {
        bytes.extend_from_slice(&u32::try_from(fields[1].len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(&fields[1]);
    }
    // Captured once from this continuous native lifecycle, never regenerated
    // by the replay verifier. Every subsequent run must match every byte.
    // No file writer, update mode, or environment-controlled bypass remains.
    let fixture: &[u8] = match action {
        re::Action::Dissolve => include_bytes!(
            "../../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin"
        ),
        re::Action::Return => include_bytes!(
            "../../../frontier-node/crates/verify/tests/fixtures/wide_expedition_resident/return_v1.bin"
        ),
    };
    assert_eq!(bytes.as_slice(), fixture);
}

fn verify_resident_receipts(
    ctx: &AddrCtx,
    before: &World,
    after: &World,
    output: &rt::system_cpi::Output,
    action: frontier_abi::world_index::expedition_resident_event::Action,
    host: WideHostRef,
) {
    use frontier_abi::world_index::expedition_resident_event as re;
    assert_eq!(output.logs.len(), 2);
    assert_eq!(output.logs[0][0], frontier_abi::log::PREFIX);
    assert_eq!(output.logs[1][0], wev::WIDE_LOG_PREFIX);
    let original = re::Record::decode(ctx, &output.logs[0][1]).unwrap();
    let wide = re::Record::decode(ctx, &output.logs[1][1]).unwrap();
    original.pair(&wide).unwrap();
    assert_eq!(original.action, action);
    assert_eq!(original.identity.host, host);
    let targets = original.identity.original_targets(action);
    let previous: Vec<_> = targets
        .iter()
        .map(|(entity, key)| {
            let (seq, head) = crate::layout::chain_of(before.get(*key).data()).unwrap();
            frontier_abi::log::Link {
                entity: *entity,
                seq,
                head,
            }
        })
        .collect();
    original.verify_previous(ctx, &previous, None).unwrap();
    for ((_, key), link) in targets.iter().zip(&original.original_links) {
        assert_eq!(
            crate::layout::chain_of(after.get(*key).data()).unwrap(),
            (link.seq, link.head)
        );
    }
    let province = original.identity.province;
    let (seq, head) = crate::layout::chain_of(before.get(province).data()).unwrap();
    wide.verify_previous(
        ctx,
        &[],
        Some(wev::WideLink {
            entity: wev::WideEntity::Province,
            seq,
            head,
        }),
    )
    .unwrap();
    let link = wide.wide_link.unwrap();
    assert_eq!(
        crate::layout::chain_of(after.get(province).data()).unwrap(),
        (link.seq, link.head)
    );
}

/// Actual successful invocation log-data from the continuous synthetic native
/// lifecycle. Clock metadata is a fixture claim, not a transaction signature,
/// RPC observation or authenticated ledger. No failed/rejected call is included.
fn anchor_boundary_trace(world: &World, season: [u8; 32]) {
    assert!(world.1.len() <= 256);
    let mut bytes = b"BTRCv001".to_vec();
    bytes.extend_from_slice(&PROGRAM);
    bytes.extend_from_slice(&season);
    bytes.extend_from_slice(&u32::try_from(world.1.len()).unwrap().to_le_bytes());
    for (timestamp, slot, logs) in &world.1 {
        bytes.extend_from_slice(&timestamp.to_le_bytes());
        bytes.extend_from_slice(&slot.to_le_bytes());
        assert!(logs.len() <= 32);
        bytes.extend_from_slice(&u16::try_from(logs.len()).unwrap().to_le_bytes());
        for fields in logs {
            assert_eq!(fields.len(), 2);
            for field in fields {
                assert!(field.len() <= 800);
                bytes.extend_from_slice(&u32::try_from(field.len()).unwrap().to_le_bytes());
                bytes.extend_from_slice(field);
            }
        }
    }
    // Captured once from these actual successful native handler outputs. This
    // immutable assertion has no writer, update mode or environment bypass.
    assert_eq!(
        bytes.as_slice(),
        include_bytes!(
            "../../../frontier-node/crates/fclient/tests/fixtures/original_boundary_v1.bin"
        )
    );
}
