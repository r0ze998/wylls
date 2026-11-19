//! The DEVNET playable preset reaches the wide land (devnet-preset-wide; D-1 of the verifier-wide-instrs report;
//! owner decision B7: expedition / wide land / conquest on devnet).
//!
//! The wide land starts at ring 129 (`world_index::land::FIRST_WIDE_RING`): WideRequestRingSeed(129) names the
//! legacy RingSeed of ring 128 as its previous ring. `S1_LOCAL_7D` (the localnet preset the devnet profile used)
//! has `r_max` 16 and no `r_max_ceiling`, so ring 17 never opens and no wide instruction but WideSetRules can land.
//! `S1_DEVNET_WIDE_7D` is `S1_LOCAL_7D` with `r_max_ceiling` 128, θ 1 bp and a 36 SOL province fund.
//!
//! Real SBF artefact: the devnet build of the playable lane (`devnet-playable-sbf`, version 0x4804), deployed
//! through LoaderV3 at the harness's ordinary program id, executed in LiteSVM at LiteSVM's rent (6,960
//! lamports/byte: the stricter of the two rates the preset's fund is sized for). Real instructions: AnnounceSeason,
//! CreateSeason (the preset's bytes), InitBeaconLogs, InitShards, ConsumeGenesisSeed (a real quicknet round, BLS
//! verified by the syscalls), OpenRing 0..=128, FoldOccupancy, ExtendFrontier 17..=128, WideRequestRingSeed(129),
//! WideSetRules, WideOpenProvince on ring 129.
//!
//! **Crafted state (each named where used), because the release-shaped devnet build has no test beacon and the
//! harness has only 32 real quicknet rounds (near genesis):**
//! - each crowding ring's RingSeed (4..=128) and the wide ring-129 seed are written SEEDED as ConsumeRingSeed /
//!   WideConsumeRingSeed would leave them (status + a literal seed; the round stays the one the program fixed);
//! - wedge 0's folded `wedge_occupied` is set to 1 (one settler) after a real fold: a real first home needs a
//!   ticket settle on a bell seed, i.e. a beacon round the fixture lacks.
//!
//! Not reached here (needs beacon rounds at the season's later bells: tlock seals, bell seeds): the wide claim's
//! settle, an expedition's depart / reveal / arrival and a keep or Free City capture. Their program paths are
//! covered by the host harness through the real dispatch (`permutation-frontier --features wide-world-experimental`,
//! `wide_land_runtime_tests`, `wide_expedition_*`, `wide_conquest_*`) and by the localnet lane runners in
//! `frontier-node/crates/itest` (fixture rim home at ring 128). This test proves the precondition all of them
//! assume and the devnet preset lacked: rings 0..=128 opened by the program and wide land open at ring 129.

use frontier_abi::addr::AddrCtx;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::presets::{SeasonParamsV2, S1_DEVNET_WIDE_7D, S1_LOCAL_7D};
use frontier_abi::world_index::land::{
    self as wl, province as WP, WideProvince, WideRingSeed, FIRST_WIDE_RING,
};
use frontier_abi::world_index::rules::{
    self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule, WIDE_RULES_CONFIG_VERSION,
};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::WideCoord;
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, program_id, repo_root, Build, Chain, Profile, SendResult,
};
use permutation_frontier_svm_tests::world::land::{rd_u16, rd_u32};
use permutation_frontier_svm_tests::world::{params_v2_for, World};
use permutation_frontier_svm_tests::{
    sha256, AccountMeta, Address, FrontierError as E, Instruction, Signer,
};
use permutation_rules::frontier::geometry::R_MAX_HARD;

const LANE_VERSION: u16 = 0x4804;
const BELL: i64 = 600;
/// A wide instruction has no `L(kind)` row: the lane clients request the runtime's loaded-data limit, and the
/// keeper's ladder CU ceiling.
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
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (set PSF_SO_DEVNET_PLAYABLE, or build it: scripts/build-frontier-devnet-playable-sbf.sh)",
            path.display()
        )
    })
}

fn chain() -> Chain {
    Chain::with_program(Build::Release, &devnet_so(), program_id())
}

/// A version-0x4804 season of preset `p` through the program's own lifecycle, Running, genesis rings 0..=3 open.
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
    expect_lands(
        w.consume_genesis(c),
        "ConsumeGenesisSeed (real quicknet round)",
    );
    let g = w.genesis_ts();
    if c.now < g {
        c.set_time(g);
    }
    w.open_genesis_rings(c);
    // The genesis rings are opened whole (a keeper's `lazy_provinces` still does), ring 0 included.
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

fn extend(c: &mut Chain, w: &World, d: u16) -> SendResult {
    let ix = fclient::ix::v2::extend_frontier(&w.a, w.keeper.pubkey(), d);
    c.send(&[ix], &[&w.keeper])
}

/// Crafted (module doc): wedge 0 has one settler on the folded values (θ = 1 bp needs exactly that).
fn one_settler(c: &mut Chain, w: &World) {
    let fr = c.data(&w.a.frontier());
    assert!(
        rd_u32(&fr, FR::WEDGE_OPEN) > 0,
        "fold first: wedge 0 has open sites"
    );
    c.edit(&w.a.frontier(), |d| {
        d[FR::WEDGE_OCCUPIED..FR::WEDGE_OCCUPIED + 4].copy_from_slice(&1u32.to_le_bytes())
    });
}

/// Crafted (module doc): the RingSeed of ring `d`, Requested by OpenRing, written Seeded as ConsumeRingSeed would.
fn seed_legacy(c: &mut Chain, w: &World, d: u16) {
    let k = w.a.ring_seed(d);
    assert_eq!(
        c.data(&k)[RS::STATUS],
        RS::STATUS_REQUESTED,
        "ring {d} requested"
    );
    let seed = sha256(&[b"devnet-preset-wide crafted ring seed", &d.to_le_bytes()]);
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

/// Crafted (module doc): the wide ring seed written Seeded through the record model, as the verified
/// WideConsumeRingSeed would (its round unchanged).
fn seed_wide(c: &mut Chain, w: &World, ring: u64) -> [u8; 32] {
    let k = addr(wl::ring_seed_address(&ctx(w), ring));
    let rec = WideRingSeed::read(&c.data(&k)).expect("a wide ring seed");
    assert_eq!(rec.status, wl::SeedStatus::Requested);
    let seed = sha256(&[b"devnet-preset-wide crafted wide seed", &ring.to_le_bytes()]);
    let seeded = rec.seed_with(rec.round, seed).expect("seed_with");
    c.edit(&k, |d| seeded.write(d).expect("write"));
    seed
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
        // The playable conquest world's rule bytes (itest conquest_world::RULES): the deployed Free City site.
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

/// D-1, as it was: a season from `S1_LOCAL_7D` (the localnet preset; the devnet profile's before this change)
/// grows to ring 16 and no further, so ring 128 never opens and wide ring 129 can never be requested.
#[test]
fn s1_local_7d_never_reaches_the_wide_land() {
    let mut c = chain();
    let p = S1_LOCAL_7D;
    let w = lane_season(&mut c, 21, p);
    w.fold(&mut c);
    assert_eq!(p.cq.r_max_ceiling, 0);
    // θ 55 %: crafted, every open site of wedge 0 occupied (the occupancy rule is not this test's point).
    let open0 = rd_u32(&c.data(&w.a.frontier()), FR::WEDGE_OPEN);
    c.edit(&w.a.frontier(), |d| {
        d[FR::WEDGE_OCCUPIED..FR::WEDGE_OCCUPIED + 4].copy_from_slice(&open0.to_le_bytes())
    });
    for d in p.base.genesis_ring as u16 + 1..=p.base.r_max {
        c.advance(BELL);
        expect_lands(w.open_ring(&mut c, d), "OpenRing (up to r_max 16)");
        seed_legacy(&mut c, &w, d);
    }
    c.advance(BELL);
    assert_code(w.open_ring(&mut c, p.base.r_max + 1), E::BadData); // beyond r_max
    assert_code(extend(&mut c, &w, p.base.r_max + 1), E::BadData); // no ceiling: the map is final
    assert_code(request_wide(&mut c, &w, FIRST_WIDE_RING), E::BadAccount); // no RingSeed 128, ever
    assert!(c.is_absent(&w.a.ring_seed(R_MAX_HARD)));
}

/// The devnet playable preset: the program opens every legacy ring to the rim one bell apart, the funds pass
/// every check (also at 6,960 lamports/byte), ring 129 is requested on the program's own rules, and a wide
/// province with its genesis Free City is opened there.
#[test]
fn s1_devnet_wide_7d_opens_the_rim_and_the_wide_land() {
    let mut c = chain();
    let p = S1_DEVNET_WIDE_7D;
    let w = lane_season(&mut c, 22, p);
    assert_eq!(w.rings_opened(&c), 4, "genesis rings 0-3");
    w.fold(&mut c);
    one_settler(&mut c, &w);

    // No province past the genesis rings is opened (a keeper's `lazy_provinces`), so the one settler keeps θ.
    let g = p.base.genesis_ring as u16;
    let start_bell = w.now_bell(&c);
    for d in g + 1..=R_MAX_HARD {
        c.advance(BELL);
        if d > p.base.r_max {
            // The same bell as the last opening is refused, as OpenRing's (shown once, at the first extension).
            let l = expect_lands(extend(&mut c, &w, d), "ExtendFrontier");
            assert!(l.cu < 200_000);
        }
        expect_lands(w.open_ring(&mut c, d), "OpenRing (crowding ring)");
        seed_legacy(&mut c, &w, d);
    }
    assert_eq!(w.rings_opened(&c), R_MAX_HARD + 1);
    assert_eq!(rd_u16(&c.data(&w.a.frontier()), FR::R_MAX_EXT), R_MAX_HARD);
    let bells = w.now_bell(&c) - start_bell;
    assert_eq!(
        bells,
        (R_MAX_HARD - g) as u32,
        "one ring per bell: 125 bells, ~21 h"
    );
    assert!(w.now_bell(&c) < p.base.join_close_bell);
    // The ceiling holds.
    c.advance(BELL);
    assert_code(extend(&mut c, &w, R_MAX_HARD + 1), E::BadData);
    assert_code(w.open_ring(&mut c, R_MAX_HARD + 1), E::BadData);

    // Wide ring 129 on the program's own rules (previous seeded, a bell since, θ, every fund ≥ 129 × rent).
    let l = expect_lands(
        request_wide(&mut c, &w, FIRST_WIDE_RING),
        "WideRequestRingSeed(129)",
    );
    eprintln!("WideRequestRingSeed(129): {} CU", l.cu);
    assert_code(request_wide(&mut c, &w, FIRST_WIDE_RING), E::AlreadyDone);
    let seed = seed_wide(&mut c, &w, FIRST_WIDE_RING);
    // Ring 130 needs a bell since 129 opened.
    assert_code(request_wide(&mut c, &w, FIRST_WIDE_RING + 1), E::TooEarly);

    expect_lands(set_rules(&mut c, &w), "WideSetRules");
    let coord = WideCoord::checked(FIRST_WIDE_RING as i64, 0).expect("ring 129");
    assert_eq!(coord.ring(), FIRST_WIDE_RING);
    let fund = w.a.province_fund(coord.wedge().unwrap_or(0));
    let before = c.lamports(&fund);
    let l = expect_lands(open_wide(&mut c, &w, coord), "WideOpenProvince (ring 129)");
    eprintln!("WideOpenProvince(129, 0): {} CU", l.cu);
    let pk = addr(wl::province_address(&ctx(&w), coord));
    let pd = c.data(&pk);
    assert_eq!(pd.len(), WP::SIZE);
    let prov = WideProvince::read(&pd).expect("a wide province");
    assert_eq!(prov.coord, coord);
    assert_eq!(prov.ring_seed, seed);
    assert_eq!(
        before - c.lamports(&fund),
        c.lamports(&pk),
        "paid from its wedge fund"
    );
    assert_code(open_wide(&mut c, &w, coord), E::AlreadyDone);

    // The next wide ring follows one bell later.
    c.advance(BELL);
    expect_lands(
        request_wide(&mut c, &w, FIRST_WIDE_RING + 1),
        "WideRequestRingSeed(130)",
    );
}

/// The fund check of the first wide ring, at its exact boundary: every wedge fund must hold `129 × rent(4,864)`
/// above its own rent (3.2713 SOL at 5,080 lamports/byte, the harness's and devnet's rate; 4.48 SOL at 6,960).
/// `S1_LOCAL_7D`'s 3.5 SOL a wedge would leave about 9 province openings of headroom per wedge at 5,080 and fail
/// outright at 6,960; the devnet preset's 6 SOL leaves ≈ 110 and ≈ 44 (`frontier-abi` pins the arithmetic).
#[test]
fn ring_129_needs_every_fund_above_129_wide_province_rents() {
    let mut c = chain();
    let p = S1_DEVNET_WIDE_7D;
    let w = lane_season(&mut c, 23, p);
    w.fold(&mut c);
    one_settler(&mut c, &w);
    for d in p.base.genesis_ring as u16 + 1..=R_MAX_HARD {
        c.advance(BELL);
        if d > p.base.r_max {
            expect_lands(extend(&mut c, &w, d), "ExtendFrontier");
        }
        expect_lands(w.open_ring(&mut c, d), "OpenRing");
        seed_legacy(&mut c, &w, d);
    }
    c.advance(BELL);
    let need = FIRST_WIDE_RING * c.rent(WP::SIZE);
    let floor = c.rent(frontier_abi::layout::world::province_fund::SIZE) + need;
    assert_eq!(need, 3_271_357_440, "129 x (128 + 4,864) x 5,080");
    // Crafted: wedge 3's fund one lamport short, then exactly at the floor.
    let f3 = w.a.province_fund(3);
    let full = c.lamports(&f3);
    assert!(
        full > floor + 2_000_000_000,
        "the devnet fund leaves > 2 SOL of headroom here"
    );
    c.edit_lamports(&f3, floor - 1);
    assert_code(request_wide(&mut c, &w, FIRST_WIDE_RING), E::Insufficient);
    c.edit_lamports(&f3, floor);
    expect_lands(
        request_wide(&mut c, &w, FIRST_WIDE_RING),
        "WideRequestRingSeed(129) at the floor",
    );
    c.edit_lamports(&f3, full);
}
