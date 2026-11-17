#![cfg(feature = "wide-economy-experimental")]
//! Literal public identities, codecs, public hashes and scalar arithmetic only.
use frontier_abi::layout::{
    header as HDR,
    province::{province as PV, site as SM},
    world::season as S,
};
use frontier_abi::v2::{
    layout::{
        player::{citizen as C, holding as H},
        province::{conquest as CR, site as SM2},
        write_header, AccountKind,
    },
    presets::{FRONTIER_7, RULESET_HASH_V3, SEASON_CQ_OFFSET},
};
use frontier_abi::world_index::{
    conquest::{self as wc, CaptureBinding, WideCaptureEscrow, WideConquest, WideConquestEntry},
    holding::{self as wh, WideHolding},
    land::{self as wl, WideProvince},
    wide_ix::SettleSiege,
    ProvinceKey, WideCoord, WideHostRef, WorldId,
};
use frontier_abi::{
    addr::{self, AddrCtx},
    bytes::*,
    conquest_model::{Record, SiteRecordRules},
};
use permutation_rules::hash::sha256;
use verify_core::wide_conquest_settle::*;
const PROGRAM: [u8; 32] = [0x12; 32];
const WALLET: [u8; 32] = [0xa1; 32];
const FUNDER: [u8; 32] = [0xd5; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
fn account(
    address: [u8; 32],
    owner: [u8; 32],
    data: Vec<u8>,
    lamports: u64,
    writable: bool,
) -> Account {
    Account {
        address,
        owner,
        present: owner != [0; 32] || !data.is_empty(),
        data,
        lamports,
        signer: false,
        writable,
    }
}
fn fixture(lapse: bool) -> (Context, Vec<Account>) {
    let bump = 254; // Explicit supplied public PDA bump; no key generation.
    let season = sha256(&[
        S::PDA_PREFIX,
        &SID.to_le_bytes(),
        &[bump],
        &PROGRAM,
        b"ProgramDerivedAddress",
    ]);
    let ctx = AddrCtx {
        season,
        program: PROGRAM,
    };
    let world = WorldId::derive_legacy_season(&season, &PROGRAM).unwrap();
    let coord = WideCoord::checked(129, 0).unwrap();
    let key = ProvinceKey::new(world, coord);
    let citizen = ctx.citizen(&WALLET);
    let mut sd = vec![0; AccountKind::Season.size()];
    assert!(write_header(&mut sd, AccountKind::Season, SID));
    sd[S::STATUS] = S::STATUS_RUNNING;
    sd[S::BUMP] = bump;
    wr_i64(&mut sd, S::GENESIS_TS, GENESIS);
    wr_u32(&mut sd, S::END_BELL, 100);
    wr_arr(&mut sd, S::RULESET_HASH, &RULESET_HASH_V3);
    wr_u16(
        &mut sd,
        S::PROGRAM_VERSION,
        verify_core::wide_economy::WIDE_S1_PROGRAM_VERSION,
    );
    sd[SEASON_CQ_OFFSET..SEASON_CQ_OFFSET + 128].copy_from_slice(&FRONTIER_7.to_bytes());
    let mut cd = vec![0; C::SIZE];
    assert!(write_header(&mut cd, AccountKind::Citizen, SID));
    wr_arr(&mut cd, C::WALLET, &WALLET);
    wr_u64(&mut cd, C::CITIZEN_TAG, addr::citizen_tag(&citizen));
    wr_u32(&mut cd, C::TICKET_BELL, C::NO_TICKET);
    for slot in 1..=3 {
        cd[C::holding_of_slot(slot) + 5] = C::EMPTY_GEN;
    }
    cd[C::FACTION] = 1;
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
    pd[PV::site(0) + SM::STATE] = SM2::STATE_FREE_CITY;
    pd[PV::site(0) + SM::FACTION] = 6;
    wr_u32(&mut pd, PV::RESOLVED_NEXT, 100);
    let source = WideHostRef::new(key, 1, 8, 0).unwrap();
    let rules = if lapse {
        SiteRecordRules {
            kind: CR::KIND_SIEGE,
            faction: 1,
            flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
            required: 1,
            target: CR::target(CR::TARGET_FREE_CITY, 2),
            bell: 1,
            ..Default::default()
        }
    } else {
        SiteRecordRules {
            kind: CR::KIND_NONE,
            faction: CR::BARRED_NONE,
            flags: CR::FLAG_SLOT_OWED,
            required: 2,
            ..Default::default()
        }
    };
    let entry = WideConquestEntry {
        rules,
        citizen,
        source: if lapse { Some(source) } else { None },
        actor_tag: addr::citizen_tag(&citizen),
        reserved_slot: 2,
        original_target_gen: 0,
        declaration_bell: 1,
    };
    entry.prefix().write(&mut pd, 0).unwrap();
    // Encode fixture input directly; no settle/refund model can generate an expectation.
    let mut td = WideConquest::new(SID, key, [0xd6; 32])
        .unwrap()
        .to_bytes()
        .to_vec();
    let e = &mut td[128..256];
    e[..6].copy_from_slice(&[
        rules.kind,
        rules.faction,
        rules.flags,
        rules.progress,
        rules.required,
        rules.target,
    ]);
    wr_u32(e, 12, rules.bell);
    e[16..48].copy_from_slice(&citizen);
    if lapse {
        e[48..104].copy_from_slice(&source.to_bytes());
    }
    wr_u64(e, 104, entry.actor_tag);
    e[112] = 2;
    wr_u32(e, 114, 1);
    let (escrow, _) = WideCaptureEscrow::new(SID, world, citizen, [0xd6; 32])
        .unwrap()
        .reserve(
            2,
            CaptureBinding {
                key,
                site: 0,
                gen: 0,
                declaration_bell: 1,
            },
            500,
            FUNDER,
        )
        .unwrap();
    let mut b = vec![
        account([0xd4; 32], [0; 32], vec![], 900, false),
        account(season, PROGRAM, sd, 900, false),
        account(wl::province_address(&ctx, coord), PROGRAM, pd, 900, true),
        account(wc::conquest_address(&ctx, key), PROGRAM, td, 900, true),
        account(citizen, PROGRAM, cd.clone(), 900, true),
        account(
            wc::capture_escrow_address(&ctx, &citizen),
            PROGRAM,
            escrow.to_bytes().to_vec(),
            600,
            true,
        ),
        account(FUNDER, [0; 32], vec![], 900, true),
    ];
    b[0].signer = true;
    if lapse {
        let hd = WideHolding::captured_free_city(
            wh::CapturedFreeCity {
                world,
                season_id: SID,
                coord,
                site: 1,
                gen: 8,
                slot: 3,
                owner_citizen: citizen,
                tile: 0,
                tier: 1,
                captured_bell: 1,
                current_bell: Some(100),
                now: GENESIS + 60000,
                rent_payer: FUNDER,
            },
            &cd,
            &[0; 61],
            &[0; 61],
        )
        .unwrap();
        b.push(account(
            wh::holding_address(&ctx, coord, 1),
            PROGRAM,
            hd.to_vec(),
            900,
            true,
        ));
    }
    (
        Context {
            program: PROGRAM,
            season,
            command: SettleSiege { site: 0 }.to_bytes().to_vec(),
            now_ts: GENESIS + 60000,
            escrow_rent_minimum: 100,
            holding_rent_minimum: 500,
        },
        b,
    )
}
fn verify(c: &Context, b: &[Account], s: &Staged) -> bool {
    verify_settle_siege(&Evidence {
        context: c,
        before: b,
        after: &s.after,
        events: &s.events,
    })
    .is_ok()
}
#[test]
fn failed_exact_effects_and_changed_target() {
    let (c, mut b) = fixture(false);
    b[2].data[PV::site(0) + SM::GEN] = 23;
    b[2].data[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    let s = stage_settle_siege(&c, &b).unwrap();
    assert!(verify(&c, &b, &s));
    assert_eq!(s.events.len(), 1);
    assert_eq!(
        (s.refund, s.added_gold_milli, s.burned_gold_milli),
        (500, 0, 0)
    );
    assert_eq!(s.after[5].lamports, 100);
    assert_eq!(s.after[6].lamports, 1400);
    assert!(s.after[3].data[128..256].iter().all(|x| *x == 0));
    assert_eq!(s.after[4].data[C::SLOTS], b[4].data[C::SLOTS] & !0x14);
    let p = Record::read(&s.after[2].data, 0).unwrap();
    assert_eq!(p.kind, CR::KIND_NONE);
    assert_eq!(p.faction, CR::BARRED_NONE);
}
#[test]
fn lapse_live_and_cap_full_still_credit_receipt() {
    let (c, mut b) = fixture(true);
    let s = stage_settle_siege(&c, &b).unwrap();
    assert!(verify(&c, &b, &s));
    assert_eq!(s.events.len(), 2);
    assert_eq!(
        s.added_gold_milli + s.burned_gold_milli,
        u64::from(FRONTIER_7.siege_stake_gold) * 1000
    );
    let mut h = verify_core::holding::read(&b[7].data).unwrap();
    let g = &mut h.stores[5];
    g.value = g.cap;
    wr_u16(&mut b[7].data, HDR::LAYOUT_VERSION, 2);
    verify_core::holding::write(&mut b[7].data, &h, c.now_ts).unwrap();
    wr_u16(&mut b[7].data, HDR::LAYOUT_VERSION, 3);
    let s = stage_settle_siege(&c, &b).unwrap();
    assert_eq!(s.added_gold_milli, 0);
    assert_eq!(s.events.len(), 2);
}
#[test]
fn absent_stale_nonlive_sources_burn_without_receipt() {
    for mode in 0..3 {
        let (c, mut b) = fixture(true);
        match mode {
            0 => {
                b[7].owner = [0; 32];
                b[7].data.clear();
                b[7].present = false;
            }
            1 => b[7].data[H::GEN] = 9,
            _ => b[7].data[H::STATE] = 0,
        };
        let s = stage_settle_siege(&c, &b).unwrap();
        assert_eq!(s.events.len(), 1);
        assert_eq!(s.added_gold_milli, 0);
        assert_eq!(
            s.burned_gold_milli,
            u64::from(FRONTIER_7.siege_stake_gold) * 1000
        );
        assert_eq!(s.after[7], b[7]);
    }
}
#[test]
fn malformed_sources_never_become_burn() {
    for mode in 0..4 {
        let (c, mut b) = fixture(true);
        match mode {
            0 => b[7].address = [99; 32],
            1 => b[7].owner = [99; 32],
            2 => b[7].data[0] ^= 1,
            _ => b[7].present = false,
        };
        assert!(stage_settle_siege(&c, &b).is_err());
    }
}
#[test]
fn rent_ledger_floor_and_overflow() {
    let (mut c, mut b) = fixture(false);
    c.holding_rent_minimum = 1000;
    assert_eq!(stage_settle_siege(&c, &b).unwrap().refund, 500);
    c.holding_rent_minimum = 123;
    let s = stage_settle_siege(&c, &b).unwrap();
    assert_eq!(s.refund, 123);
    assert_eq!(rd_u64(&s.after[5].data, 160), Some(377));
    b[5].lamports = 599;
    assert!(stage_settle_siege(&c, &b).is_err());
    b[5].lamports = 600;
    b[6].lamports = u64::MAX;
    assert!(stage_settle_siege(&c, &b).is_err());
}
#[test]
fn early_unresolved_and_capture_due_refused() {
    let (mut c, mut b) = fixture(true);
    c.now_ts -= 600;
    assert!(stage_settle_siege(&c, &b).is_err());
    c.now_ts += 600;
    wr_u32(&mut b[2].data, PV::RESOLVED_NEXT, 99);
    assert!(stage_settle_siege(&c, &b).is_err());
    wr_u32(&mut b[2].data, PV::RESOLVED_NEXT, 100);
    b[3].data[128] = CR::KIND_CAPTURE_DUE;
    assert!(stage_settle_siege(&c, &b).is_err());
}
#[test]
fn exact_bundle_and_every_post_byte() {
    let (c, b) = fixture(true);
    let s = stage_settle_siege(&c, &b).unwrap();
    for mode in 0..5 {
        let mut wrong = s.clone();
        match mode {
            0 => {
                wrong.events.pop();
            }
            1 => {
                wrong.events.push(wrong.events[1].clone());
            }
            2 => wrong.events.reverse(),
            3 => wrong.events[1][10] ^= 1,
            _ => wrong.after[3].data[24] ^= 1,
        };
        assert!(!verify(&c, &b, &wrong));
    }
    for i in 0..b.len() {
        let mut wrong = s.clone();
        wrong.after[i].lamports += 1;
        assert!(!verify(&c, &b, &wrong));
    }
    let mut wrong = s.clone();
    wrong.after[4].data[HDR::EVENT_HEAD] ^= 1;
    assert!(!verify(&c, &b, &wrong));
}
#[test]
fn funder_alias_is_propagated_and_self_refund_rejected() {
    let (c, mut b) = fixture(true);
    let source = b[7].address;
    b[5].data[128..160].copy_from_slice(&source);
    b[6] = b[7].clone();
    let s = stage_settle_siege(&c, &b).unwrap();
    assert!(verify(&c, &b, &s));
    assert_eq!(s.after[6], s.after[7]);
    assert_eq!(s.after[7].lamports, b[7].lamports + 500);
    let escrow = b[5].address;
    b[5].data[128..160].copy_from_slice(&escrow);
    b[6] = b[5].clone();
    assert!(stage_settle_siege(&c, &b).is_err());
}
#[test]
fn alias_conflicts_and_extra_roles_refused() {
    let (c, mut b) = fixture(false);
    b.push(b[6].clone());
    assert!(stage_settle_siege(&c, &b).is_err());
    b.pop();
    b[0].address = b[6].address;
    b[0].lamports += 1;
    assert!(stage_settle_siege(&c, &b).is_err());
}
#[test]
fn proof_limits_are_explicit() {
    let (c, b) = fixture(false);
    let s = stage_settle_siege(&c, &b).unwrap();
    assert_eq!(
        s.limits,
        ConditionalProofLimits::CallerSuppliedInvocationNoAuthenticationOrSeasonReplay
    );
    assert!(!FULL_SEASON_REPLAY_SUPPORTED);
}
#[test]
fn citizen_version_is_not_just_a_tag() {
    let (c, mut b) = fixture(false);
    wr_u16(&mut b[4].data, HDR::LAYOUT_VERSION, 1);
    assert!(stage_settle_siege(&c, &b).is_err());
}

#[test]
fn raw_input_is_checked_before_economic_arithmetic() {
    let (c, mut b) = fixture(true);
    let s = stage_settle_siege(&c, &b).unwrap();
    // A valid structural Holding with changed economic bytes must fail the
    // raw commitment, rather than enter settlement using the altered input.
    b[7].data[H::LAST_OWNER_ACTION..H::LAST_OWNER_ACTION + 8]
        .copy_from_slice(&i64::MAX.to_le_bytes());
    let error = verify_settle_siege(&Evidence {
        context: &c,
        before: &b,
        after: &s.after,
        events: &s.events,
    })
    .unwrap_err();
    assert_eq!(error, "raw input commitment mismatch");
    assert!(stage_settle_siege(&c, &b).is_err());
}

#[test]
fn ended_status_and_initial_mirror_rules() {
    let (mut c, mut b) = fixture(true);
    c.now_ts -= 600;
    b[1].data[S::STATUS] = S::STATUS_ENDED;
    b[7].owner = [0; 32];
    b[7].data.clear();
    b[7].present = false;
    // Explicit Ended status admits a lapse even before the time end bell.
    assert!(stage_settle_siege(&c, &b).is_ok());
    b[2].data[PV::site(0) + SM::GEN] = 1;
    assert!(stage_settle_siege(&c, &b).is_err());
}

#[test]
fn writable_signer_funder_alias_matches_shape() {
    let (c, mut b) = fixture(false);
    b[0] = b[6].clone();
    b[0].signer = true;
    let s = stage_settle_siege(&c, &b).unwrap();
    assert_eq!(s.after[0].lamports, s.after[6].lamports);
    assert!(verify(&c, &b, &s));
}
