//! Isolated host fixtures. Literal identities, public PDA/with-seed hashing,
//! static signer flags, byte codecs and the existing game kernels only.
//! No signing, private derivation, native crypto, exporter or network. Tests
//! call private handler bodies because dispatch intentionally remains closed.
//! The System stub accepts only the one authenticated AllocateWithSeed CPI.
#[path = "wide_conquest_lifecycle_tests.rs"]
mod lifecycle;

use super::*;
use frontier_abi::conquest_model::{SiteRecordRules, SiteReport, SiteTransitionMirror};
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::presets::{FRONTIER_7, SEASON_CQ_OFFSET};
use solana_program::{instruction::Instruction, program_error::ProgramError};
use std::{boxed::Box, sync::Mutex};

const PROGRAM: [u8; 32] = [0x12; 32];
const WALLET: [u8; 32] = [0xa1; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const FUNDER: [u8; 32] = [0xd5; 32];
const RENT_PAYER: [u8; 32] = [0xd6; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const BIG: u64 = 10_000_000_000;
static SERIAL: Mutex<()> = Mutex::new(());
static LOGS: Mutex<Vec<(Vec<u8>, Vec<u8>)>> = Mutex::new(Vec::new());

struct Stubs;
impl solana_program::program_stubs::SyscallStubs for Stubs {
    fn sol_log(&self, _: &str) {}
    fn sol_log_data(&self, fields: &[&[u8]]) {
        if fields.len() == 2 {
            LOGS.lock()
                .unwrap()
                .push((fields[0].to_vec(), fields[1].to_vec()));
        }
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let d = &ix.data;
        if ix.program_id.to_bytes() != prologue::ids::SYSTEM_PROGRAM
            || d.len() < 84
            || u32::from_le_bytes(d[..4].try_into().unwrap()) != 9
        {
            return Err(ProgramError::InvalidInstructionData);
        }
        let n = u64::from_le_bytes(d[36..44].try_into().unwrap()) as usize;
        if d.len() != 84 + n || infos.len() != 2 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let base: [u8; 32] = d[4..36].try_into().unwrap();
        let owner: [u8; 32] = d[52 + n..84 + n].try_into().unwrap();
        let space = u64::from_le_bytes(d[44 + n..52 + n].try_into().unwrap()) as usize;
        if space != wh::wide_holding::SIZE
            || owner != PROGRAM
            || base != key(&infos[1])
            || key(&infos[0]) != permutation_rules::hash::sha256(&[&base, &d[44..44 + n], &owner])
            || !seeds.iter().any(|s| {
                Pubkey::create_program_address(s, &Pubkey::new_from_array(PROGRAM))
                    .is_ok_and(|k| k.to_bytes() == base)
            })
        {
            return Err(ProgramError::InvalidSeeds);
        }
        if !init::is_absent(&infos[0]) {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        infos[0].resize(space)?;
        infos[0].assign(&Pubkey::new_from_array(owner));
        Ok(())
    }
}
struct Installed(Option<Box<dyn solana_program::program_stubs::SyscallStubs>>);
impl Drop for Installed {
    fn drop(&mut self) {
        if let Some(old) = self.0.take() {
            solana_program::program_stubs::set_syscall_stubs(old);
        }
    }
}
fn install() -> Installed {
    LOGS.lock().unwrap().clear();
    Installed(Some(solana_program::program_stubs::set_syscall_stubs(
        Box::new(Stubs),
    )))
}
fn account(
    k: [u8; 32],
    owner: [u8; 32],
    bytes: Vec<u8>,
    lamports: u64,
    signer: bool,
    writable: bool,
) -> AccountInfo<'static> {
    // Same runtime padding convention as the existing key-free host harness.
    // Every account has capacity for the sole supported Holding allocation.
    let len = bytes.len();
    let mut kb = vec![0u8; 36];
    kb[..4].copy_from_slice(&(len as u32).to_le_bytes());
    kb[4..].copy_from_slice(&k);
    let kb = Box::leak(kb.into_boxed_slice());
    // SAFETY: Pubkey alignment is one; the preceding u32 is original_data_len.
    let pk = unsafe { &*(kb.as_ptr().add(4) as *const Pubkey) };
    let mut data = vec![0; 8 + len.max(wh::wide_holding::SIZE)];
    data[..8].copy_from_slice(&(len as u64).to_le_bytes());
    data[8..8 + len].copy_from_slice(&bytes);
    let data = Box::leak(data.into_boxed_slice());
    let owner = Box::leak(Box::new(Pubkey::new_from_array(owner)));
    AccountInfo::new(
        pk,
        signer,
        writable,
        Box::leak(Box::new(lamports)),
        &mut data[8..8 + len],
        owner,
        false,
    )
}
fn wallet(k: [u8; 32], signer: bool, writable: bool, balance: u64) -> AccountInfo<'static> {
    account(
        k,
        prologue::ids::SYSTEM_PROGRAM,
        vec![],
        balance,
        signer,
        writable,
    )
}
fn program() -> Pubkey {
    Pubkey::new_from_array(PROGRAM)
}
fn time(bell: u32) {
    prologue::set_test_clock(GENESIS + bell as i64 * 600, 1);
}
fn put(d: &mut [u8], off: usize, bytes: &[u8]) {
    d[off..off + bytes.len()].copy_from_slice(bytes);
}
fn snapshot(a: &[AccountInfo]) -> Vec<([u8; 32], u64, Vec<u8>)> {
    a.iter()
        .map(|ai| {
            (
                ai.owner.to_bytes(),
                ai.lamports(),
                ai.try_borrow_data().unwrap().to_vec(),
            )
        })
        .collect()
}
fn refused(a: &[AccountInfo], call: impl FnOnce() -> R<()>) {
    let before = snapshot(a);
    let logs = LOGS.lock().unwrap().clone();
    assert!(call().is_err());
    assert_eq!(
        snapshot(a),
        before,
        "direct refusal changed live state; no rollback used"
    );
    assert_eq!(*LOGS.lock().unwrap(), logs);
}
struct Fixture {
    a: Vec<AccountInfo<'static>>,
    funder: AccountInfo<'static>,
    rent_payer: AccountInfo<'static>,
    k: ProvinceKey,
}
impl Fixture {
    fn new(kind: u8, prefund: u64) -> Self {
        time(10);
        let (sp, bump) = Pubkey::find_program_address(
            &[
                crate::addr::SEASON_PREFIX,
                &crate::addr::season_seed_id(SID),
            ],
            &program(),
        );
        let ctx = addr::ctx(&sp.to_bytes(), &PROGRAM);
        let world = world_of(&ctx).unwrap();
        let coord = WideCoord::checked(129, 0).unwrap();
        let k = ProvinceKey::new(world, coord);
        let ck = ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&WALLET));
        let mut sd = vec![0; K2::Season.size()];
        assert!(write_header(&mut sd, K2::Season, SID));
        sd[S::STATUS] = S::STATUS_RUNNING;
        sd[S::BUMP] = bump;
        put(&mut sd, S::GENESIS_TS, &GENESIS.to_le_bytes());
        put(&mut sd, S::END_BELL, &100u32.to_le_bytes());
        put(&mut sd, S::RULESET_HASH, &RULESET_HASH);
        put(
            &mut sd,
            S::PROGRAM_VERSION,
            &crate::PROGRAM_VERSION.to_le_bytes(),
        );
        put(&mut sd, SEASON_CQ_OFFSET, &FRONTIER_7.to_bytes());
        let mut cd = vec![0; K2::Citizen.size()];
        assert!(write_header(&mut cd, K2::Citizen, SID));
        put(&mut cd, C::WALLET, &WALLET);
        put(
            &mut cd,
            C::CITIZEN_TAG,
            &frontier_abi::addr::citizen_tag(&ck).to_le_bytes(),
        );
        put(&mut cd, C::TICKET_BELL, &C::NO_TICKET.to_le_bytes());
        for slot in 1..=3 {
            cd[C::holding_of_slot(slot) + 5] = C::EMPTY_GEN;
        }
        cd[C::FACTION] = 1;
        cd[C::JOIN_SHARD] = 0;
        wh::bind(&mut cd, 3).unwrap();
        wc::mark(&mut cd, 2).unwrap();
        let mut pd = vec![0; wl::province::SIZE];
        WideProvince {
            season_id: SID,
            world,
            coord,
            wedge: coord.wedge().unwrap(),
            region: 0,
            opened_bell: 1,
            readiness: wl::readiness::REQUIRED,
            seed_round: 1,
            ring_seed: [7; 32],
            funded_lamports: 0,
        }
        .write_identity(&mut pd)
        .unwrap();
        pd[PV::SITE_COUNT] = 2;
        pd[PV::SITES] = 0;
        put(&mut pd, PV::RESOLVED_NEXT, &3u32.to_le_bytes());
        let mirror = SiteTransitionMirror {
            state: SM2::STATE_FREE_CITY,
            gen: 0,
            order: 0,
            held_since_hour: 0,
            walls_committed: 0,
        };
        let e = wc::WideConquestEntry {
            rules: SiteRecordRules {
                kind: CR::KIND_SIEGE,
                faction: 1,
                flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
                required: 1,
                target: CR::target(CR::TARGET_FREE_CITY, 2),
                bell: 1,
                ..Default::default()
            },
            citizen: ck,
            source: Some(WideHostRef::new(k, 1, 8, 0).unwrap()),
            actor_tag: frontier_abi::addr::citizen_tag(&ck),
            reserved_slot: 2,
            original_target_gen: 0,
            declaration_bell: 1,
        };
        let mut plan = WideConquest::new(SID, k, RENT_PAYER)
            .unwrap()
            .declare(0, Record::ZERO, mirror, e)
            .unwrap();
        if kind != CR::KIND_SIEGE {
            plan = plan
                .conquest
                .step(
                    0,
                    plan.prefix,
                    e,
                    mirror,
                    2,
                    SiteReport {
                        holders: if kind == CR::KIND_CAPTURE_DUE { 2 } else { 0 },
                        defender_present: kind != CR::KIND_CAPTURE_DUE,
                    },
                    &StepParams {
                        genesis_ts: GENESIS,
                        end_bell: 100,
                        cq: FRONTIER_7,
                    },
                )
                .unwrap();
        }
        plan.prefix.write(&mut pd, 0).unwrap();
        pd[PV::site(0) + SM::STATE] = if kind == CR::KIND_CAPTURE_DUE {
            SM::STATE_HOLDING
        } else {
            SM2::STATE_FREE_CITY
        };
        pd[PV::site(0) + SM::FACTION] = if kind == CR::KIND_CAPTURE_DUE {
            1
        } else {
            NEUTRAL
        };
        pd[PV::site(0) + SM::GEN] = u8::from(kind == CR::KIND_CAPTURE_DUE);
        pd[PV::site(0) + SM::ORDER] = if kind == CR::KIND_CAPTURE_DUE { 2 } else { 0 };
        pd[PV::site(0) + SM::TIER] = 1;
        let rent = init::rent(wh::wide_holding::SIZE).unwrap();
        let (escrow, _) = WideCaptureEscrow::new(SID, world, ck, RENT_PAYER)
            .unwrap()
            .reserve(2, binding(k, 0, e), rent, FUNDER)
            .unwrap();
        let mut js = vec![0; K2::JoinShard.size()];
        assert!(write_header(&mut js, K2::JoinShard, SID));
        js[crate::layout::join_shard::FACTION] = 1;
        let source = WideHolding::captured_free_city(
            wh::CapturedFreeCity {
                world,
                season_id: SID,
                coord,
                site: 1,
                gen: 8,
                slot: 3,
                owner_citizen: ck,
                tile: 0,
                tier: 1,
                captured_bell: 1,
                current_bell: Some(10),
                now: GENESIS + 6000,
                rent_payer: FUNDER,
            },
            &cd,
            &[0; 61],
            &[0; 61],
        )
        .unwrap();
        let mk = |key, bytes| account(key, PROGRAM, bytes, BIG, false, true);
        let mut season = mk(sp.to_bytes(), sd);
        season.is_writable = false;
        Self {
            a: vec![
                wallet(PAYER, true, true, BIG),
                season,
                mk(wl::province_address(&ctx, coord), pd),
                mk(
                    wc::conquest_address(&ctx, k),
                    plan.conquest.to_bytes().to_vec(),
                ),
                mk(ck, cd),
                mk(ctx.join_shard(1, 0), js),
                account(
                    wc::capture_escrow_address(&ctx, &ck),
                    PROGRAM,
                    escrow.to_bytes().to_vec(),
                    init::rent(wc::CAPTURE_ESCROW_SIZE).unwrap() + rent,
                    false,
                    true,
                ),
                wallet(wh::holding_address(&ctx, coord, 0), false, true, prefund),
                mk(wh::holding_address(&ctx, coord, 1), source.to_vec()),
                wallet(prologue::ids::SYSTEM_PROGRAM, false, false, 0),
            ],
            funder: wallet(FUNDER, false, true, BIG),
            rent_payer: wallet(RENT_PAYER, false, true, BIG),
            k,
        }
    }
    fn siege(&self, with_source: bool) -> Vec<AccountInfo<'static>> {
        let mut a = vec![
            self.a[0].clone(),
            self.a[1].clone(),
            self.a[2].clone(),
            self.a[3].clone(),
            self.a[4].clone(),
            self.a[6].clone(),
            self.funder.clone(),
        ];
        if with_source {
            a.push(self.a[8].clone());
        }
        a
    }
    fn close_escrow(&self) -> Vec<AccountInfo<'static>> {
        vec![
            self.a[0].clone(),
            self.a[1].clone(),
            self.a[4].clone(),
            self.a[6].clone(),
            self.rent_payer.clone(),
            self.funder.clone(),
        ]
    }
    fn abort(&self) {
        self.a[1].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ABORTED;
    }
}

#[test]
fn failed_refund_clears_exact_obligation_and_retry_is_unchanged() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_NONE, 0);
    let a = f.siege(false);
    let source_before = snapshot(&[f.a[8].clone()]);
    let rent = init::rent(wh::wide_holding::SIZE).unwrap();
    settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 }).unwrap();
    assert_eq!(f.funder.lamports(), BIG + rent);
    assert_eq!(
        Ro(&a[4].try_borrow_data().unwrap()).u8(C::SLOTS).unwrap() & (4 | 16),
        0
    );
    assert_eq!(snapshot(&[f.a[8].clone()]), source_before);
    assert!(table(
        &program(),
        &addr::ctx(&key(&a[1]), &PROGRAM),
        SID,
        f.k,
        &a[3]
    )
    .unwrap()
    .entry(0)
    .unwrap()
    .is_none());
    refused(&a, || {
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
    });
    assert_eq!(LOGS.lock().unwrap().len(), 1);
}

#[test]
fn failed_refund_negatives_are_directly_atomic() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    for case in 0..6 {
        let f = Fixture::new(CR::KIND_NONE, 0);
        let mut a = f.siege(false);
        match case {
            0 => a[6] = wallet([0xee; 32], false, true, BIG),
            1 => **a[6].try_borrow_mut_lamports().unwrap() = u64::MAX,
            2 => a[4].try_borrow_mut_data().unwrap()[C::SLOTS] ^= 16,
            3 => a.push(f.a[8].clone()),
            4 => {
                put(
                    &mut a[2].try_borrow_mut_data().unwrap(),
                    frontier_abi::layout::header::EVENT_SEQ,
                    &u64::MAX.to_le_bytes(),
                );
            }
            _ => a[3].is_writable = false,
        }
        refused(&a, || {
            settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
        });
    }
    let f = Fixture::new(CR::KIND_NONE, 0);
    let a = f.siege(false);
    let _borrow = a[6].try_borrow_lamports().unwrap();
    refused(&a, || {
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
    });
}

#[test]
fn active_lapse_waits_for_final_bell_then_burns_missing_source() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    let mut a = f.siege(true);
    time(100);
    refused(&a, || {
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
    });
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &100u32.to_le_bytes(),
    );
    a[7] = wallet(key(&a[7]), false, true, 0);
    settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 }).unwrap();
    assert_eq!(a[7].data_len(), 0);
    assert_eq!(LOGS.lock().unwrap().len(), 1);
}

#[test]
fn active_lapse_rejects_mirror_contradictions_before_any_effect() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    for (off, value) in [
        (PV::SITE_COUNT, 0),
        (PV::site(0) + SM::STATE, SM::STATE_HOLDING),
        (PV::site(0) + SM::GEN, 1),
        (PV::site(0) + SM::ORDER, 2),
        (PV::site(0) + SM::FACTION, 1),
    ] {
        let f = Fixture::new(CR::KIND_SIEGE, 0);
        let a = f.siege(true);
        time(100);
        let mut pd = a[2].try_borrow_mut_data().unwrap();
        put(&mut pd, PV::RESOLVED_NEXT, &100u32.to_le_bytes());
        pd[off] = value;
        drop(pd);
        refused(&a, || {
            settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
        });
    }
}

#[test]
fn failed_refund_checks_site_bounds_but_not_later_target_ownership() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_NONE, 0);
    let a = f.siege(false);
    a[2].try_borrow_mut_data().unwrap()[PV::SITE_COUNT] = 0;
    refused(&a, || {
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
    });
    let mut pd = a[2].try_borrow_mut_data().unwrap();
    pd[PV::SITE_COUNT] = 2;
    let off = PV::site(0);
    pd[off + SM::STATE] = SM::STATE_HOLDING;
    pd[off + SM::GEN] = 9;
    pd[off + SM::ORDER] = 3;
    pd[off + SM::FACTION] = 4;
    let mirror_before = pd[off..off + SM::SIZE].to_vec();
    drop(pd);
    settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 }).unwrap();
    assert_eq!(
        &a[2].try_borrow_data().unwrap()[off..off + SM::SIZE],
        &mirror_before
    );
    assert_eq!(
        a[6].lamports(),
        BIG + init::rent(wh::wide_holding::SIZE).unwrap()
    );
}

#[test]
fn capture_prefunding_counts_and_immunity_are_committed_once() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let rent = init::rent(wh::wide_holding::SIZE).unwrap();
    for prefund in [0, rent / 2, rent + 123] {
        let f = Fixture::new(CR::KIND_CAPTURE_DUE, prefund);
        let before_escrow = f.a[6].lamports();
        settle_capture_inner(&program(), &f.a, &wix::SettleCapture { site: 0 }).unwrap();
        assert_eq!(f.a[7].lamports(), prefund.max(rent));
        assert_eq!(
            f.a[6].lamports(),
            before_escrow - rent.saturating_sub(prefund)
        );
        let hd = f.a[7].try_borrow_data().unwrap();
        assert_eq!(Ro(&hd).arr::<32>(H::RENT_PAYER).unwrap(), FUNDER);
        assert_eq!(Ro(&hd).u8(H::STATE).unwrap(), H::STATE_FINAL);
        assert_eq!(Ro(&hd).u32(H::CAPTURED_BELL).unwrap(), 2);
        drop(hd);
        let cd = f.a[4].try_borrow_data().unwrap();
        assert_eq!(wh::binding_of(&cd, 2).unwrap(), SlotBinding::Wide);
        drop(cd);
        for off in [JS2::EXTRA_HOLDINGS, JS2::CAPTURED_IN] {
            assert_eq!(Ro(&f.a[5].try_borrow_data().unwrap()).u32(off).unwrap(), 1);
        }
        let record = Record::read(&f.a[2].try_borrow_data().unwrap(), 0).unwrap();
        assert_eq!(record.bell, 3 + FRONTIER_7.immunity_bells as u32);
        refused(&f.a, || {
            settle_capture_inner(&program(), &f.a, &wix::SettleCapture { site: 0 })
        });
    }
}

#[test]
fn active_lapse_credits_exact_legacy_cap_and_stale_generation_burns() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    for stale in [false, true] {
        let f = Fixture::new(CR::KIND_SIEGE, 0);
        let a = f.siege(true);
        time(100);
        put(
            &mut a[2].try_borrow_mut_data().unwrap(),
            PV::RESOLVED_NEXT,
            &100u32.to_le_bytes(),
        );
        if stale {
            a[7].try_borrow_mut_data().unwrap()[H::GEN] = 9;
        }
        let mut expected = a[7].try_borrow_data().unwrap().to_vec();
        if !stale {
            let gold = permutation_rules::frontier::holding::Resource::Gold as usize;
            let mut economic = hold::read_holding(&expected).unwrap();
            economic.stores[gold].value = economic.stores[gold].cap - 2 * MILLI;
            hold::write_holding(&mut expected, &economic, GENESIS + 6000).unwrap();
            a[7].try_borrow_mut_data()
                .unwrap()
                .copy_from_slice(&expected);
            hold::settle_tiered(
                &mut economic,
                GENESIS + 60_000,
                hold::terrain_ore(&expected).unwrap(),
            )
            .unwrap();
            let (credited, burned) = crate::proc::conquest::credit_capped(
                &mut economic,
                FRONTIER_7.siege_stake_gold as i64 * MILLI,
            );
            assert!(credited <= 2 * MILLI);
            assert!(burned > 0);
            hold::write_holding(&mut expected, &economic, GENESIS + 60_000).unwrap();
        }
        let logs_before = LOGS.lock().unwrap().len();
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 }).unwrap();
        let mut got = a[7].try_borrow_data().unwrap().to_vec();
        // Compare the entire economic/identity output independently of receipt
        // chain fields, which the handler alone advances on a live credit.
        if !stale {
            let h = frontier_abi::layout::header::EVENT_SEQ;
            let end = frontier_abi::layout::header::EVENT_HEAD + 32;
            got[h..end].copy_from_slice(&expected[h..end]);
        }
        assert_eq!(got, expected);
        assert_eq!(
            LOGS.lock().unwrap().len() - logs_before,
            if stale { 1 } else { 2 }
        );
    }
}

#[test]
fn capture_due_cannot_use_failed_settlement_and_wrong_source_never_burns_silently() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_CAPTURE_DUE, 0);
    let a = f.siege(true);
    refused(&a, || {
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
    });
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    let mut a = f.siege(true);
    time(100);
    put(
        &mut a[2].try_borrow_mut_data().unwrap(),
        PV::RESOLVED_NEXT,
        &100u32.to_le_bytes(),
    );
    a[7] = wallet([0xee; 32], false, true, 0);
    refused(&a, || {
        settle_siege_inner(&program(), &a, &wix::SettleSiege { site: 0 })
    });
}

#[test]
fn capture_refusals_precede_allocation_and_source_credit() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    for case in 0..7 {
        let mut f = Fixture::new(CR::KIND_CAPTURE_DUE, 0);
        match case {
            0 => f.a[2].try_borrow_mut_data().unwrap()[PV::site(0) + SM::GEN] = 2,
            1 => f.a[2].try_borrow_mut_data().unwrap()[PV::site(0) + SM::FACTION] = 2,
            2 => put(
                &mut f.a[5].try_borrow_mut_data().unwrap(),
                JS2::CAPTURED_IN,
                &u32::MAX.to_le_bytes(),
            ),
            3 => put(
                &mut f.a[8].try_borrow_mut_data().unwrap(),
                frontier_abi::layout::header::EVENT_SEQ,
                &u64::MAX.to_le_bytes(),
            ),
            4 => **f.a[6].try_borrow_mut_lamports().unwrap() = 0,
            5 => f.a[7] = wallet([0xff; 32], false, true, 0),
            _ => f.a[9] = wallet([0xee; 32], false, false, 0),
        }
        refused(&f.a, || {
            settle_capture_inner(&program(), &f.a, &wix::SettleCapture { site: 0 })
        });
    }
    let f = Fixture::new(CR::KIND_CAPTURE_DUE, 0);
    let _borrow = f.a[7].try_borrow_data().unwrap();
    refused(&f.a, || {
        settle_capture_inner(&program(), &f.a, &wix::SettleCapture { site: 0 })
    });
}

#[test]
fn terminal_escrow_clears_markers_without_table_or_source() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    f.abort();
    let a = f.close_escrow();
    let refund = init::rent(wh::wide_holding::SIZE).unwrap();
    let remainder = a[3].lamports() - refund;
    close_capture_escrow_inner(&program(), &a).unwrap();
    assert!(init::is_absent(&a[3]));
    assert_eq!(a[4].lamports(), BIG + remainder);
    assert_eq!(a[5].lamports(), BIG + refund);
    assert_eq!(
        wc::wide_reservations(Ro(&a[2].try_borrow_data().unwrap()).u8(C::SLOTS).unwrap()).unwrap(),
        0
    );
    assert_eq!(LOGS.lock().unwrap()[0].0, receipt::SIDECAR_LOG_PREFIX);
    refused(&a, || close_capture_escrow_inner(&program(), &a));
}

#[test]
fn terminal_alias_credits_are_aggregated_and_overflow_refuses() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    for overflow in [false, true] {
        let f = Fixture::new(CR::KIND_SIEGE, 0);
        f.abort();
        let mut a = f.close_escrow();
        // Rebuild with immutable payer == current funder using public codec.
        let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
        let rent = init::rent(wh::wide_holding::SIZE).unwrap();
        let old = escrow(&program(), &ctx, SID, f.k.world(), &a[2], &a[3]).unwrap();
        let (e, _) = WideCaptureEscrow::new(SID, f.k.world(), key(&a[2]), FUNDER)
            .unwrap()
            .reserve(2, old.binding(2).unwrap().unwrap(), rent, FUNDER)
            .unwrap();
        a[3].try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&e.to_bytes());
        a[4] = a[5].clone();
        let total = a[3].lamports();
        if overflow {
            **a[4].try_borrow_mut_lamports().unwrap() = u64::MAX - rent;
            refused(&a, || close_capture_escrow_inner(&program(), &a));
        } else {
            close_capture_escrow_inner(&program(), &a).unwrap();
            assert_eq!(a[4].lamports(), BIG + total);
            assert!(init::is_absent(&a[3]));
        }
    }
}

#[test]
fn terminal_requires_present_active_citizen_but_empty_escrow_can_follow_citizen_close() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    f.abort();
    let mut a = f.close_escrow();
    a[2] = wallet(key(&a[2]), false, true, 0);
    refused(&a, || close_capture_escrow_inner(&program(), &a));
    let empty = WideCaptureEscrow::new(SID, f.k.world(), key(&a[2]), RENT_PAYER).unwrap();
    a[3].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&empty.to_bytes());
    a.pop();
    close_capture_escrow_inner(&program(), &a).unwrap();
    assert!(init::is_absent(&a[3]));
}

#[test]
fn terminal_table_close_needs_only_its_immutable_payer_and_season() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_CAPTURE_DUE, 0);
    f.abort();
    let a = vec![
        f.a[0].clone(),
        f.a[1].clone(),
        f.a[3].clone(),
        f.rent_payer.clone(),
    ];
    let x = wix::CloseConquest { p: 129, q: 0 };
    close_conquest_inner(&program(), &a, &x).unwrap();
    assert!(init::is_absent(&a[2]));
    assert_eq!(a[3].lamports(), BIG * 2);
    refused(&a, || close_conquest_inner(&program(), &a, &x));
    // Escrow obligations can still be terminally cleared after the table is gone.
    close_capture_escrow_inner(&program(), &f.close_escrow()).unwrap();
}

#[test]
fn terminal_close_preserves_ended_grace_and_accepts_canonical_tombstone() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    let a = f.close_escrow();
    a[1].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ENDED;
    time(100);
    refused(&a, || close_capture_escrow_inner(&program(), &a));
    // 72 hours are 432 ten-minute bells. Just before remains refused.
    time(531);
    refused(&a, || close_capture_escrow_inner(&program(), &a));
    time(532);
    close_capture_escrow_inner(&program(), &a).unwrap();
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    let mut a = f.close_escrow();
    let mut tomb = a[1].try_borrow_data().unwrap()[..S::TOMBSTONE_SIZE].to_vec();
    tomb[S::STATUS] = S::STATUS_CLOSED;
    a[1] = account(key(&a[1]), PROGRAM, tomb, BIG, false, false);
    close_capture_escrow_inner(&program(), &a).unwrap();
}

#[test]
fn terminal_self_recipient_and_borrow_conflict_refuse_before_resize() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    f.abort();
    let mut a = f.close_escrow();
    let ctx = addr::ctx(&key(&a[1]), &PROGRAM);
    let old = escrow(&program(), &ctx, SID, f.k.world(), &a[2], &a[3]).unwrap();
    let rent = init::rent(wh::wide_holding::SIZE).unwrap();
    let (self_paid, _) = WideCaptureEscrow::new(SID, f.k.world(), key(&a[2]), key(&a[3]))
        .unwrap()
        .reserve(2, old.binding(2).unwrap().unwrap(), rent, FUNDER)
        .unwrap();
    a[3].try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&self_paid.to_bytes());
    a[4] = a[3].clone();
    refused(&a, || close_capture_escrow_inner(&program(), &a));
    let f = Fixture::new(CR::KIND_SIEGE, 0);
    f.abort();
    let a = f.close_escrow();
    let _borrow = a[2].try_borrow_data().unwrap();
    refused(&a, || close_capture_escrow_inner(&program(), &a));
}

#[test]
fn dispatch_gate_and_public_settle_wrappers_remain_closed() {
    let _serial = SERIAL.lock().unwrap();
    let _stub = install();
    let f = Fixture::new(CR::KIND_CAPTURE_DUE, 0);
    assert!(!super::super::CONQUEST_LIFECYCLE_ENABLED);
    refused(&f.a, || {
        settle_capture(&program(), &f.a, &wix::SettleCapture { site: 0 })
    });
    refused(&f.a, || {
        crate::dispatch(&program(), &f.a, &wix::SettleCapture { site: 0 }.to_bytes())
    });
}
