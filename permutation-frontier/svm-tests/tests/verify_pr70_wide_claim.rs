//! verify-pr70 (independent verification of PR #70, devnet-preset-wide): in a season from `S1_DEVNET_WIDE_7D`
//! on the real `devnet-playable-sbf` artefact, after the map has grown to the rim and wide ring 129 is open, a
//! player whose first home is at the rim files a real **WideClaimSite (0xD9)** on ring 129; a heartland first
//! home cannot (`OutpostRule`, range 3 from the slot-1 home).
//!
//! Real: AnnounceSeason .. ConsumeGenesisSeed, OpenRing 0..=128, ExtendFrontier 17..=128, OpenProvince on ring
//! 128, WideRequestRingSeed(129), WideSetRules, WideOpenProvince(129, 0), WideClaimSite.
//! Crafted (as in `devnet_preset_wide.rs`): the crowding rings' seeds (4..=128) and ring 129's seed written
//! Seeded; wedge 0's folded `wedge_occupied` = 1. Also crafted here: the player's Citizen and final first Holding
//! (`World::craft_estate`) on the real ring-128 province — a real first home needs a ticket settled on a bell
//! seed, i.e. a beacon round this harness lacks.
//! Not reached: the ticket's settle (bell seed), an expedition, a capture.

use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::player::holding as H;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::presets::{SeasonParamsV2, S1_DEVNET_WIDE_7D, S1_LOCAL_7D};
use frontier_abi::v2::CqError as Cq;
use frontier_abi::world_index::land::{self as wl, WideRingSeed, FIRST_WIDE_RING};
use frontier_abi::world_index::rules::{
    self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule, WIDE_RULES_CONFIG_VERSION,
};
use frontier_abi::world_index::ticket::{self as wt, TicketStatus, WideTicket};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::WideCoord;
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, program_id, repo_root, Build, Chain, Profile, SendResult,
};
use permutation_frontier_svm_tests::world::holding::Estate;
use permutation_frontier_svm_tests::world::land::rd_u32;
use permutation_frontier_svm_tests::world::{params_v2_for, World};
use permutation_frontier_svm_tests::{sha256, AccountMeta, Address, Instruction, Signer};
use permutation_rules::frontier::geometry::R_MAX_HARD;
use permutation_rules::frontier::holding::Tier;

const LANE_VERSION: u16 = 0x4804;
const BELL: i64 = 600;
const WIDE: Profile = Profile {
    cu_limit: Some(1_400_000),
    cu_price: 0,
    loaded_limit: None,
    heap: None,
};

fn devnet_so() -> Vec<u8> {
    let path = std::env::var("PSF_SO_DEVNET_PLAYABLE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            repo_root().join(
                "permutation-frontier/target/deploy-devnet-playable-sbf/permutation_frontier.so",
            )
        });
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn lane_season(c: &mut Chain, id: u64, p: SeasonParamsV2) -> World {
    let mut p = params_v2_for(c, p);
    p.base.program_version = LANE_VERSION;
    let w = World::with_v2(c, id, p);
    expect_lands(w.announce(c), "AnnounceSeason (0x4804)");
    expect_lands(w.create(c), "CreateSeason (0x4804)");
    expect_lands(w.init_logs(c), "InitBeaconLogs");
    for f in 0..6 {
        expect_lands(w.init_shards(c, f), "InitShards");
    }
    expect_lands(w.consume_genesis(c), "ConsumeGenesisSeed");
    let g = w.genesis_ts();
    if c.now < g {
        c.set_time(g);
    }
    w.open_genesis_rings(c);
    for d in 0..=w.genesis_ring() as u32 {
        w.open_provinces(c, d, None);
    }
    w
}

fn ctx(w: &World) -> AddrCtx {
    AddrCtx {
        season: w.a.season.to_bytes(),
        program: w.a.program.to_bytes(),
    }
}
fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}
fn system() -> Address {
    Address::new_from_array([0; 32])
}
fn ro(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn rw(k: Address) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn signer(k: Address) -> AccountMeta {
    AccountMeta::new(k, true)
}

fn seed_legacy(c: &mut Chain, w: &World, d: u16) {
    let k = w.a.ring_seed(d);
    assert_eq!(c.data(&k)[RS::STATUS], RS::STATUS_REQUESTED);
    let seed = sha256(&[b"verify-pr70 crafted ring seed", &d.to_le_bytes()]);
    c.edit(&k, |x| {
        x[RS::SEED..RS::SEED + 32].copy_from_slice(&seed);
        x[RS::STATUS] = RS::STATUS_SEEDED;
    });
}

fn request_wide(c: &mut Chain, w: &World, ring: u64) -> SendResult {
    let cx = ctx(w);
    let previous = if ring == FIRST_WIDE_RING {
        w.a.ring_seed(R_MAX_HARD)
    } else {
        addr(wl::ring_seed_address(&cx, ring - 1))
    };
    let mut m = vec![
        signer(w.keeper.pubkey()),
        ro(w.a.season),
        ro(w.a.frontier()),
        ro(previous),
        rw(addr(wl::ring_seed_address(&cx, ring))),
    ];
    m.extend(w.a.province_funds().into_iter().map(ro));
    m.push(ro(system()));
    let ix = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: wix::RequestRingSeed { ring }.to_bytes().to_vec(),
    };
    c.send_with(&WIDE, &[ix], &[&w.keeper])
}

fn seed_wide(c: &mut Chain, w: &World, ring: u64) {
    let k = addr(wl::ring_seed_address(&ctx(w), ring));
    let rec = WideRingSeed::read(&c.data(&k)).expect("a wide ring seed");
    let seed = sha256(&[b"verify-pr70 crafted wide seed", &ring.to_le_bytes()]);
    let seeded = rec.seed_with(rec.round, seed).expect("seed_with");
    c.edit(&k, |d| seeded.write(d).expect("write"));
}

fn set_rules(c: &mut Chain, w: &World) -> SendResult {
    let ix = Instruction {
        program_id: w.a.program,
        accounts: vec![
            signer(w.authority.pubkey()),
            ro(w.a.season),
            rw(addr(wr::rules_config_address(&ctx(w)))),
            ro(system()),
        ],
        data: wix::SetRules {
            config_version: WIDE_RULES_CONFIG_VERSION,
            keep_holder: KeepHolderRule::MixedInterleaved as u8,
            free_city: FreeCityRule::DeployedLe32V1 as u8,
            camp: CampRule::NoCamp as u8,
            region: RegionRule::SortKeyHashV1 as u8,
        }
        .to_bytes()
        .to_vec(),
    };
    c.send_with(&WIDE, &[ix], &[&w.authority])
}

fn open_wide(c: &mut Chain, w: &World, coord: WideCoord) -> SendResult {
    let cx = ctx(w);
    let wedge = coord.wedge().unwrap_or(0);
    let ix = Instruction {
        program_id: w.a.program,
        accounts: vec![
            signer(w.keeper.pubkey()),
            ro(w.a.season),
            rw(addr(wl::ring_seed_address(&cx, coord.ring()))),
            rw(w.a.province_fund(wedge)),
            rw(addr(wl::province_address(&cx, coord))),
            ro(addr(wr::rules_config_address(&cx))),
            ro(system()),
        ],
        data: wix::OpenProvince {
            p: coord.p(),
            q: coord.q(),
        }
        .to_bytes()
        .to_vec(),
    };
    c.send_with(&WIDE, &[ix], &[&w.keeper])
}

/// 0xD9 WideClaimSite for the estate's player (actor = payer = its wallet), anchored at its slot-1 first home.
fn claim(c: &mut Chain, w: &World, e: &Estate, coord: WideCoord, site: u8) -> SendResult {
    let cx = ctx(w);
    let wallet = e.wallet.pubkey();
    let ix = Instruction {
        program_id: w.a.program,
        accounts: vec![
            signer(wallet),
            signer(wallet),
            ro(w.a.season),
            rw(e.citizen),
            ro(w.a.frontier()),
            rw(addr(wl::province_address(&cx, coord))),
            rw(addr(wt::ticket_address(&cx, &e.citizen.to_bytes()))),
            rw(e.holding),
            ro(e.province),
            rw(e.holding),
            ro(e.province),
            ro(system()),
        ],
        data: wix::ClaimSite {
            p: coord.p(),
            q: coord.q(),
            site,
            slot: 2,
        }
        .to_bytes()
        .to_vec(),
    };
    c.send_with(&WIDE, &[ix], &[&e.wallet])
}

#[test]
fn a_rim_home_files_a_wide_claim_on_ring_129_and_a_heartland_home_cannot() {
    let mut c = Chain::with_program(Build::Release, &devnet_so(), program_id());
    let p = S1_DEVNET_WIDE_7D;
    let w = lane_season(&mut c, 31, p);
    w.fold(&mut c);
    // Crafted: one folded settler in wedge 0 (θ = 1 bp).
    assert!(rd_u32(&c.data(&w.a.frontier()), FR::WEDGE_OPEN) > 0);
    c.edit(&w.a.frontier(), |d| {
        d[FR::WEDGE_OCCUPIED..FR::WEDGE_OCCUPIED + 4].copy_from_slice(&1u32.to_le_bytes())
    });
    let g = p.base.genesis_ring as u16;
    for d in g + 1..=R_MAX_HARD {
        c.advance(BELL);
        if d > p.base.r_max {
            let ix = fclient::ix::v2::extend_frontier(&w.a, w.keeper.pubkey(), d);
            expect_lands(c.send(&[ix], &[&w.keeper]), "ExtendFrontier");
        }
        expect_lands(w.open_ring(&mut c, d), "OpenRing");
        seed_legacy(&mut c, &w, d);
    }
    // Lazily: only the one rim province the player lives in is opened (real OpenProvince, paid by its fund).
    expect_lands(w.open_province(&mut c, 128, 0), "OpenProvince(128, 0)");
    c.advance(BELL);
    expect_lands(
        request_wide(&mut c, &w, FIRST_WIDE_RING),
        "WideRequestRingSeed(129)",
    );
    seed_wide(&mut c, &w, FIRST_WIDE_RING);
    expect_lands(set_rules(&mut c, &w), "WideSetRules");
    let target = WideCoord::checked(129, 0).expect("ring 129");
    let l = expect_lands(open_wide(&mut c, &w, target), "WideOpenProvince(129, 0)");
    eprintln!("verify-pr70 WideOpenProvince(129,0): {} CU", l.cu);
    assert!(w.now_bell(&c) < p.base.join_close_bell);

    // Crafted rim first home at (128, 0), distance 1 from (129, 0); faction = its wedge.
    let rim = w.craft_estate(&mut c, "rim", 0, (128, 0), 0);
    // Crafted heartland first home at ring 3 (a genesis province, opened whole by the program).
    let heart = w.craft_estate(&mut c, "heart", 0, (3, 0), 0);
    // Crafted: order 1 (a first home), as SettleTicket writes it (`craft_estate` leaves the byte 0).
    for e in [&rim, &heart] {
        c.edit(&e.holding, |d| d[H::ORDER] = 1);
    }
    // Q-W1 (owner, 2026-11-20): the devnet wide preset's `outpost_tier_min` is 0, so a fresh rim village (a
    // Hamlet) anchors a wide claim; the S1_LOCAL_7D preset keeps 1 = Town.
    assert_eq!(p.cq.outpost_tier_min, 0);
    assert_eq!(S1_LOCAL_7D.cq.outpost_tier_min, 1);
    // Crafted: stores for the settler cost (both homes stay Hamlets).
    for e in [&rim, &heart] {
        w.edit_kholding(&mut c, e, |h| assert_eq!(h.tier, Tier::Hamlet));
        w.enrich(&mut c, e, 10_000);
    }
    c.advance(1);

    // The heartland home is 126 provinces from ring 129: outpost_range 3 refuses it.
    assert_code(claim(&mut c, &w, &heart, target, 1), Cq::OutpostRule);

    let l = expect_lands(
        claim(&mut c, &w, &rim, target, 0),
        "WideClaimSite(129, 0) from a rim home",
    );
    eprintln!("verify-pr70 WideClaimSite: {} CU", l.cu);
    let rk = addr(wt::ticket_address(&ctx(&w), &rim.citizen.to_bytes()));
    let rec = WideTicket::read(&c.data(&rk)).expect("a wide ticket record");
    assert_eq!(rec.status, TicketStatus::Open);
    assert_eq!(rec.citizen, rim.citizen.to_bytes());
    // One ticket at a time.
    c.advance(1);
    assert!(
        claim(&mut c, &w, &rim, target, 1).is_err(),
        "a second filing is refused"
    );
}
