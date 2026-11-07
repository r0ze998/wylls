//! Key-free host harness of the **experimental wide land write path**
//! (`wide-world-experimental`), a child of `map_growth_runtime_tests` so
//! it shares that module's accounts, syscall stubs, clock and serial lock.
//! Filter: `map_growth_runtime_tests::wide_land::`.
//!
//! What it shows, through the program's real `dispatch`:
//!
//! - **the seed provenance writes** (0xD6, 0xD7): a wide ring seed for ring
//!   129 requested after the deployed OpenRing gates, its round the
//!   kernel's `ring_seed_round`, paid by the payer; the chain to ring 130;
//!   every refusal; the consume refusing a wrong round before the signature
//!   and failing closed on the host;
//! - **the rules configuration** (0xDB): written once by the Season's
//!   authority, refused for anyone else, for an unset or unknown byte and
//!   for another version; read back as written;
//! - **the opening** (0xD8): without the configuration the readiness gate
//!   (`NotImplemented`, nothing written); with it a **whole wide
//!   province** created from the wedge fund: the wide terrain kernel's
//!   bytes, zero legacy identity, the keep on the deployed symmetric tile
//!   held by the configured candidate nation, the configured Free City
//!   and camp, the deployed mirror and bells, the fund's and the seed's
//!   counters, no PS2 record; a second opening `AlreadyDone`; a fund too
//!   short `Insufficient` with nothing created; two neighbours of one
//!   wedge held by different nations (the owner's "mixed nations");
//! - **the claim gate** (0xD9): the deployed FileOutpost prerequisites
//!   run read-only over the real wide province (no first home, a Hamlet
//!   home out of range, stores short of the settler cost, the slot model,
//!   the wallet authorization, an NFT Citizen refused by address) and the
//!   refusal `NotImplemented` with nothing written once they pass;
//! - **the march gate** (0xDA): the deployed Depart checks over a wide
//!   holding (ownership, generation, world, the arrival window) and the
//!   identity gate with nothing written;
//! - **the one-inventory rule against the deployed writers**: a Citizen
//!   slot bound to a wide holding is taken for PlaceHome, skipped by the
//!   deployed free-slot rule, unusable for the deployed host-id codec, and
//!   free again after the unbind;
//! - **regression**: the deployed OpenRing and OpenProvince still refuse
//!   ring 129, and no wide address equals a legacy one.
//!
//! **Limits.** As the parent's: literal addresses, public PDA and
//! with-seed arithmetic only, no keypair and no signature (`is_signer` is
//! set by the test); ConsumeRingSeed's BLS verification cannot pass on the
//! host, so the tests write the seed as the verified instruction would
//! ([`Wide::seed_as_consume_would`], through the record model); the
//! Season's authority and the candidate bytes are literals chosen by the
//! test (the candidates are **not** approved rules). Two things are
//! **fixtures** the program cannot create: a wide holding
//! ([`Wide::fixture_holding`], under a decided claim rule the program does
//! not have) and a final Town first home at ring 128
//! ([`Wide::fixture_rim_home`]: a PlaceHome-written Holding relocated by
//! the test to the rim with stores, standing in for the FileTicket lottery
//! that is not run here). A refused instruction keeps what it wrote before
//! the refusal, so every refusal here is asserted to have written nothing.

use super::*;
use frontier_abi::conquest_model::read_keep;
use frontier_abi::ix::{HINTS_LEN, SEAL_LEN};
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::world_index::holding::{self as wh, WideHolding, HOST_IDENTITY_UNALLOCATED};
use frontier_abi::world_index::land::{
    self as wl, readiness, Decision, SeedStatus, WideProvince, WideRingSeed, WideRules,
    FIRST_WIDE_RING,
};
use frontier_abi::world_index::placement::mixed_home_nation;
use frontier_abi::world_index::rules::{
    self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule, WideRulesConfig,
};
use frontier_abi::world_index::wide_ix::{self as wix, WideIx};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use permutation_rules::frontier::terrain::wide::generate_province_wide;

use crate::layout::camp as CP;
use crate::layout::player::accrual as AC;

/// The literal seed the legacy RingSeed of ring 128 carries in the
/// pre-state (as OpenRing(128) and ConsumeRingSeed left it).
const RING128_SEED: [u8; 32] = [0x80; 32];
/// The literal seed the test gives wide ring 129, as the verified consume
/// would (module doc).
const RING129_SEED: [u8; 32] = [0x81; 32];
const RING130_SEED: [u8; 32] = [0x82; 32];
/// The Season's authority (a literal; AnnounceSeason stores the creator).
const AUTHORITY: [u8; 32] = [0xaa; 32];
/// The candidate bytes the tests configure: the interleaved mixing, a
/// Free City and a camp by the wide draws, the wide region hash. A test
/// choice, not a product decision.
const RULES: (u16, u8, u8, u8, u8) = (
    wr::WIDE_RULES_CONFIG_VERSION,
    KeepHolderRule::MixedInterleaved as u8,
    FreeCityRule::CanonicalHashV1 as u8,
    CampRule::SortKeyDrawV1 as u8,
    RegionRule::SortKeyHashV1 as u8,
);

/// The world at the legacy rim plus the wide accounts a test touches.
struct Wide {
    w: World,
    seeds: HashMap<u64, AccountInfo<'static>>,
    provinces: HashMap<(i64, i64), AccountInfo<'static>>,
    holdings: HashMap<(i64, i64, u8), AccountInfo<'static>>,
    config: Option<AccountInfo<'static>>,
}

fn c(p: i64, q: i64) -> WideCoord {
    WideCoord::checked(p, q).unwrap()
}

impl Wide {
    /// A season extended to the program's hard maximum with every legacy
    /// ring opened (`rings_opened` 129, `r_max_ext` 128), its authority
    /// stored, and the legacy RingSeed of ring 128 present and seeded at
    /// bell 0: the state OpenRing(128) and ConsumeRingSeed(128) leave,
    /// written as pre-state.
    fn rim() -> Wide {
        let mut w = World::with(Setup {
            r_max: 4,
            genesis_ring: 2,
            ceiling: R_MAX_HARD,
            rings_opened: 129,
            r_max_ext: R_MAX_HARD,
        });
        w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);
        {
            let mut sd = w.season.try_borrow_mut_data().unwrap();
            put(&mut sd, S::AUTHORITY, &AUTHORITY);
        }
        let key = w.ctx.ring_seed(R_MAX_HARD);
        let mut d = vec![0u8; RS::SIZE];
        assert!(frontier_abi::v2::layout::write_header(
            &mut d,
            K2::RingSeed,
            SEASON_ID
        ));
        put(&mut d, RS::D, &R_MAX_HARD.to_le_bytes());
        d[RS::STATUS] = RS::STATUS_SEEDED;
        put(&mut d, RS::OPENED_BELL, &0u32.to_le_bytes());
        put(&mut d, RS::T_OPEN, &GENESIS.to_le_bytes());
        put(&mut d, RS::ROUND, &1_000u64.to_le_bytes());
        put(&mut d, RS::SEED, &RING128_SEED);
        put(&mut d, RS::PROVINCES_CREATED, &768u16.to_le_bytes());
        put(&mut d, RS::PAYER, &PAYER);
        w.ring_seeds.insert(
            R_MAX_HARD,
            info(leak(key, PROGRAM, d, 0, BIG), false, false),
        );
        Wide {
            w,
            seeds: HashMap::new(),
            provinces: HashMap::new(),
            holdings: HashMap::new(),
            config: None,
        }
    }

    fn world_id(&self) -> WorldId {
        WorldId::derive_legacy_season(&self.w.ctx.season, &PROGRAM).unwrap()
    }

    /// Wide ring seed `ring`: absent at its canonical draft address until
    /// the program creates it.
    fn seed(&mut self, ring: u64) -> AccountInfo<'static> {
        let key = wl::ring_seed_address(&self.w.ctx, ring);
        self.seeds
            .entry(ring)
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wl::ring_seed::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    fn seed_record(&mut self, ring: u64) -> WideRingSeed {
        let ai = self.seed(ring);
        let d = ai.try_borrow_data().unwrap().to_vec();
        WideRingSeed::read(&d).unwrap()
    }

    /// Wide province `coord`: absent at its canonical draft address until
    /// the program creates it.
    fn province(&mut self, coord: WideCoord) -> AccountInfo<'static> {
        let key = wl::province_address(&self.w.ctx, coord);
        self.provinces
            .entry((coord.p(), coord.q()))
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wl::province::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    fn province_data(&mut self, coord: WideCoord) -> Vec<u8> {
        self.province(coord).try_borrow_data().unwrap().to_vec()
    }

    /// Wide holding `(coord, site)`: absent at its canonical draft address.
    fn holding(&mut self, coord: WideCoord, site: u8) -> AccountInfo<'static> {
        let key = wh::holding_address(&self.w.ctx, coord, site);
        self.holdings
            .entry((coord.p(), coord.q(), site))
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wh::wide_holding::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// The Season's rules configuration: absent at its canonical draft
    /// address until WideSetRules creates it.
    fn config(&mut self) -> AccountInfo<'static> {
        let key = wr::rules_config_address(&self.w.ctx);
        self.config
            .get_or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wr::rules_config::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// **Fixture** (module doc): a wide holding of `(coord, site)` owned by
    /// `owner` in `slot`, as a decided claim would write its identity (gen
    /// 1, host identity unallocated, tile 10, final), present and
    /// program-owned. The program cannot create one.
    fn fixture_holding(
        &mut self,
        coord: WideCoord,
        site: u8,
        owner: &[u8; 32],
        slot: u8,
    ) -> AccountInfo<'static> {
        let h = WideHolding::found(
            self.world_id(),
            SEASON_ID,
            coord,
            site,
            1,
            slot,
            *owner,
            &Decision::Decided(()),
        )
        .unwrap();
        let mut d = vec![0u8; wh::wide_holding::SIZE];
        d[H::TILE] = 10;
        d[H::STATE] = H::STATE_FINAL;
        h.write_identity(&mut d).unwrap();
        assert_eq!(WideHolding::read(&d), Ok(h));
        let key = wh::holding_address(&self.w.ctx, coord, site);
        let ai = info(leak(key, PROGRAM, d, 0, BIG), false, true);
        self.holdings
            .insert((coord.p(), coord.q(), site), ai.clone());
        ai
    }

    /// **Fixture** (module doc): the member's final first home moved to
    /// the rim. The member must already hold a PlaceHome-written first
    /// home at `from` (site 0): its Holding bytes are copied to the
    /// canonical address of `(128, 0)` site 0 with `P`, `Q` relocated, the
    /// tier raised to Town (the deployed outpost prerequisite) and every
    /// store set to `stores` milli-units; a legacy Province of `(128, 0)`
    /// mirrors site 0 as that home; the Citizen's slot 1 names it. What a
    /// FileTicket won at ring 128 and a Town tier-up would have left, which
    /// no test here runs. Returns the rim coordinate.
    fn fixture_rim_home(&mut self, m: &Member, from: ProvinceCoord, stores: i64) -> ProvinceCoord {
        let rim = ProvinceCoord::new(R_MAX_HARD as i32, 0);
        let mut hd = self.w.holding_data(from, 0);
        assert_eq!(hd.len(), H::SIZE, "a Holding the program created");
        assert_eq!(hd[H::STATE], H::STATE_FINAL);
        assert_eq!(hd[H::ORDER], 1);
        put(&mut hd, H::P, &(rim.p as i16).to_le_bytes());
        put(&mut hd, H::Q, &(rim.q as i16).to_le_bytes());
        hd[H::TIER] = Tier::Town as u8;
        for r in 0..RESOURCES {
            put(&mut hd, H::store(r) + AC::VALUE, &stores.to_le_bytes());
        }
        let key = self.w.ctx.holding(rim.p, rim.q, 0);
        let ai = info(leak(key, PROGRAM, hd, 0, BIG), false, true);
        self.w.holdings.insert((rim.p, rim.q, 0), ai);
        let pv = self.w.province(rim);
        {
            let mut pd = pv.try_borrow_mut_data().unwrap();
            let o = PV::site(0);
            pd[o + SM::STATE] = SM::STATE_HOLDING;
            pd[o + SM::FACTION] = m.faction;
            pd[o + SM::ORDER] = 1;
            pd[o + SM::GEN] = 1;
            pd[PV::N_SITES_USED] = 1;
        }
        {
            let mut cd = m.citizen.try_borrow_mut_data().unwrap();
            let o = C2::holding_of_slot(1);
            put(&mut cd, o + HR::P, &(rim.p as i16).to_le_bytes());
            put(&mut cd, o + HR::Q, &(rim.q as i16).to_le_bytes());
        }
        rim
    }

    /// Every store of the legacy Holding at `(c, site)` set to `stores`
    /// milli-units (a fixture edit).
    fn set_stores(&mut self, c: ProvinceCoord, site: u8, stores: i64) {
        let ai = self.w.holding(c, site);
        let mut hd = ai.try_borrow_mut_data().unwrap();
        for r in 0..RESOURCES {
            put(&mut hd, H::store(r) + AC::VALUE, &stores.to_le_bytes());
        }
    }

    /// 0xD6 WideRequestRingSeed(ring) by the payer: the previous ring's
    /// seed read-only (the legacy RingSeed 128 for ring 129, the wide seed
    /// of `ring − 1` otherwise), the six funds read-only.
    fn request(&mut self, ring: u64) -> Result<(), u32> {
        let previous = if ring == FIRST_WIDE_RING {
            with_writable(&self.w.ring_seed(R_MAX_HARD), false)
        } else {
            with_writable(&self.seed(ring.saturating_sub(1)), false)
        };
        let mut a = vec![
            self.w.payer.clone(),
            self.w.season.clone(),
            with_writable(&self.w.frontier, false),
            previous,
            self.seed(ring),
        ];
        for wd in 0..6u8 {
            a.push(with_writable(&self.w.fund(wd), false));
        }
        a.push(self.w.system.clone());
        run(&a, &wix::RequestRingSeed { ring }.to_bytes())
    }

    /// 0xD7 WideConsumeRingSeed by the payer as fee payer.
    fn consume(&mut self, ring: u64, round: u64) -> Result<(), u32> {
        let a = [self.w.payer.clone(), self.w.season.clone(), self.seed(ring)];
        run(
            &a,
            &wix::ConsumeRingSeed {
                ring,
                round,
                sig48: [0u8; 48],
                hints: [0u8; HINTS_LEN],
            }
            .to_bytes(),
        )
    }

    /// The two fields the verified consume writes (the seed, the status),
    /// through the record model, because the host cannot verify a
    /// quicknet signature and no test may sign one (module doc). Nothing
    /// else of the record changes.
    fn seed_as_consume_would(&mut self, ring: u64, seed: &[u8; 32]) {
        let rec = self.seed_record(ring);
        assert_eq!(rec.status, SeedStatus::Requested);
        let seeded = rec.seed_with(rec.round, *seed).unwrap();
        let ai = self.seed(ring);
        let mut d = ai.try_borrow_mut_data().unwrap();
        seeded.write(&mut d).unwrap();
    }

    /// 0xDB WideSetRules by `authority` (a literal wallet that signs).
    fn set_rules(&mut self, authority: [u8; 32], r: (u16, u8, u8, u8, u8)) -> Result<(), u32> {
        let a = [
            wallet(authority, true, true, BIG),
            self.w.season.clone(),
            self.config(),
            self.w.system.clone(),
        ];
        run(
            &a,
            &wix::SetRules {
                config_version: r.0,
                keep_holder: r.1,
                free_city: r.2,
                camp: r.3,
                region: r.4,
            }
            .to_bytes(),
        )
    }

    /// 0xD8 WideOpenProvince(P, Q) by the payer, the wedge fund writable,
    /// the configuration read-only.
    fn open_province(&mut self, p: i64, q: i64) -> Result<(), u32> {
        self.open_province_with_fund(
            p,
            q,
            WideCoord::checked(p, q)
                .ok()
                .and_then(|c| c.wedge())
                .unwrap_or(0),
        )
    }

    fn open_province_with_fund(&mut self, p: i64, q: i64, wedge: u8) -> Result<(), u32> {
        // Invalid wire coordinates still reach dispatch; use unrelated valid
        // fixture accounts, which must never be accessed after BadData.
        let coord = WideCoord::checked(p, q).unwrap_or_else(|_| c(129, 0));
        let a = [
            self.w.payer.clone(),
            self.w.season.clone(),
            self.seed(coord.ring()),
            with_writable(&self.w.fund(wedge), true),
            self.province(coord),
            with_writable(&self.config(), false),
            self.w.system.clone(),
        ];
        run(&a, &wix::OpenProvince { p, q }.to_bytes())
    }

    /// 0xD9 WideClaimSite by `actor` for the member's Citizen, with the
    /// legacy Holding at `(anchor, anchor_site)` as the anchor (and, as
    /// FileOutpost's slot-2 placeholders, as the previous pair).
    #[allow(clippy::too_many_arguments)]
    fn claim(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        coord: WideCoord,
        site: u8,
        slot: u8,
        anchor: ProvinceCoord,
        anchor_site: u8,
    ) -> Result<(), u32> {
        let anchor_holding = self.w.holding(anchor, anchor_site);
        let anchor_province = with_writable(&self.w.province(anchor), false);
        let a = [
            wallet(actor, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            with_writable(&self.w.frontier, false),
            self.province(coord),
            self.holding(coord, site),
            self.w.shard(m.faction, m.shard_i),
            with_writable(&anchor_holding, true),
            anchor_province.clone(),
            with_writable(&anchor_holding, false),
            anchor_province,
            self.w.system.clone(),
        ];
        run(
            &a,
            &wix::ClaimSite {
                p: coord.p(),
                q: coord.q(),
                site,
                slot,
            }
            .to_bytes(),
        )
    }

    /// 0xDA WideDepart of `host` from its holding by the member's wallet.
    fn depart(&mut self, m: &Member, host: WideHostRef, arrive_bell: u32) -> Result<(), u32> {
        let coord = host.key().coord();
        let a = [
            wallet(m.wallet, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.holding(coord, host.site()),
            self.province(coord),
            self.w.system.clone(),
        ];
        let mut seal = [0u8; SEAL_LEN];
        seal[0] = 0x80;
        run(
            &a,
            &wix::Depart {
                host: host.to_bytes(),
                transit_slot: 0,
                arrive_bell,
                tip: 14_441,
                commit: [7u8; 32],
                seal,
            }
            .to_bytes(),
        )
    }

    fn fund_lamports(&mut self) -> [u64; 6] {
        let mut v = [0u64; 6];
        for (w, x) in v.iter_mut().enumerate() {
            *x = self.w.fund(w as u8).lamports();
        }
        v
    }

    /// The whole Season patched to another program version (a production
    /// Season of the S1 program), and back.
    fn set_program_version(&self, v: u16) {
        let mut sd = self.w.season.try_borrow_mut_data().unwrap();
        put(&mut sd, S::PROGRAM_VERSION, &v.to_le_bytes());
    }

    /// Ring 129 seeded (the request through the program, the seed as the
    /// consume would write it) and the configuration written: the state
    /// every opening needs. Records drained.
    fn ready(&mut self) {
        self.w.fold();
        assert_eq!(self.request(FIRST_WIDE_RING), Ok(()));
        self.seed_as_consume_would(FIRST_WIDE_RING, &RING129_SEED);
        assert_eq!(self.set_rules(AUTHORITY, RULES), Ok(()));
        records();
    }
}

/// An absent account: System-owned, no data.
fn absent(ai: &AccountInfo) -> bool {
    *ai.owner == Pubkey::new_from_array(SYSTEM) && ai.data_len() == 0
}

// ------------------------------------------------------------------ tests

/// The seed provenance of ring 129 through the program: every deployed
/// OpenRing gate continued past the disk, the record's round from the
/// kernel, the chain to ring 130, the consume's round binding and its
/// closed failure on the host, and nothing written by any refusal.
#[test]
fn wide_land_ring_seed_is_requested_after_the_deployed_gates_and_bound_to_the_beacon_round() {
    let _g = begin();
    let now = at_bell(1);
    assert_eq!(
        crate::PROGRAM_VERSION & wix::WIDE_EXPERIMENTAL_VERSION_BIT,
        wix::WIDE_EXPERIMENTAL_VERSION_BIT,
        "an experimental wide build"
    );

    // Never folded: no wedge is at θ occupancy (after the chain and
    // absence checks, before any fund is read).
    let mut cold = Wide::rim();
    assert_eq!(cold.request(FIRST_WIDE_RING), Err(E::Capacity as u32));
    assert!(absent(&cold.seed(FIRST_WIDE_RING)));

    let mut w = Wide::rim();
    w.w.fold();
    records();
    let funds_before = w.fund_lamports();
    let frontier_before = w.w.frontier_state();
    let payer_before = w.w.payer.lamports();

    // The disk is the deployed program's: ring 128 is refused by the wide
    // path (BadData) and ring 129 by the legacy one (BadData), as before.
    assert_eq!(w.request(R_MAX_HARD as u64), Err(E::BadData as u32));
    assert_eq!(w.w.open_ring(129), Err(E::BadData as u32));
    assert_eq!(
        w.w.open_province(ProvinceCoord::new(129, 0)),
        Err(E::BadData as u32)
    );
    // A skipped ring: the previous wide seed is absent.
    assert_eq!(w.request(130), Err(E::TooEarly as u32));
    // Land before its seed.
    assert_eq!(w.open_province(129, 0), Err(E::SeedNotReady as u32));
    // A Season of the production program version is never touched.
    w.set_program_version(frontier_abi::v2::presets::PROGRAM_VERSION_S1);
    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::RulesetMismatch as u32));
    assert_eq!(w.open_province(129, 0), Err(E::RulesetMismatch as u32));
    assert_eq!(
        w.set_rules(AUTHORITY, RULES),
        Err(E::RulesetMismatch as u32)
    );
    w.set_program_version(crate::PROGRAM_VERSION);
    // A wedge fund short of `129 × rent(wide province)`.
    let need = wl::ring_rent(129, crate::init::rent(wl::province::SIZE).unwrap()).unwrap();
    let floor = crate::init::rent(PF::SIZE).unwrap();
    {
        let f = w.w.fund(4);
        **f.try_borrow_mut_lamports().unwrap() = floor + need - 1;
    }
    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::Insufficient as u32));
    {
        let f = w.w.fund(4);
        **f.try_borrow_mut_lamports().unwrap() = BIG;
    }
    // The previous ring unseeded: requested, not seeded, is `SeedNotReady`.
    {
        let rs = w.w.ring_seed(R_MAX_HARD);
        rs.try_borrow_mut_data().unwrap()[RS::STATUS] = RS::STATUS_REQUESTED;
    }
    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::SeedNotReady as u32));
    {
        let rs = w.w.ring_seed(R_MAX_HARD);
        rs.try_borrow_mut_data().unwrap()[RS::STATUS] = RS::STATUS_SEEDED;
    }
    assert!(
        absent(&w.seed(FIRST_WIDE_RING)),
        "no refusal created anything"
    );
    assert_eq!(w.fund_lamports(), funds_before);
    assert_eq!(w.w.payer.lamports(), payer_before);
    assert!(records().is_empty(), "a refusal logs nothing");

    // The request lands: the record, from the payer's lamports.
    assert_eq!(w.request(FIRST_WIDE_RING), Ok(()));
    let rent = crate::init::rent(wl::ring_seed::SIZE).unwrap();
    let ai = w.seed(FIRST_WIDE_RING);
    assert_eq!(*ai.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(ai.lamports(), rent);
    assert_eq!(ai.data_len(), wl::ring_seed::SIZE);
    assert_eq!(w.w.payer.lamports(), payer_before - rent, "the payer paid");
    assert_eq!(w.fund_lamports(), funds_before, "no fund moved");
    let rec = w.seed_record(FIRST_WIDE_RING);
    assert_eq!(rec.ring, 129);
    assert_eq!(rec.status, SeedStatus::Requested);
    assert_eq!(rec.season_id, SEASON_ID);
    assert_eq!(rec.world, w.world_id());
    assert_eq!(rec.opened_bell, 1);
    assert_eq!(rec.t_open, now);
    assert_eq!(rec.seed, [0u8; 32]);
    assert_eq!(rec.provinces_created, 0);
    assert_eq!(rec.payer, PAYER);
    assert_eq!(
        rec.round,
        ring_seed_round(
            &BeaconClock {
                genesis: DRAND_GENESIS,
                period: DRAND_PERIOD as i64,
            },
            now,
            SEED_MARGIN
        ),
        "the kernel's round of the request time"
    );
    assert_eq!(rec.terrain_seed(), None);
    // No legacy account moved and nothing was logged.
    assert_eq!(w.w.frontier_state(), frontier_before);
    assert_eq!(
        rd_u16(
            &w.w.ring_seed(R_MAX_HARD).try_borrow_data().unwrap(),
            RS::PROVINCES_CREATED
        ),
        768
    );
    assert!(records().is_empty(), "no PS2 record has an allocated kind");
    // No wide address is a legacy one.
    assert_ne!(
        wl::ring_seed_address(&w.w.ctx, 129),
        w.w.ctx.ring_seed(129),
        "the legacy RingSeed grammar still names ring 129 elsewhere; never used"
    );
    assert_ne!(
        wl::province_address(&w.w.ctx, c(129, 0)),
        w.w.ctx.province(129, 0)
    );
    assert_ne!(wr::rules_config_address(&w.w.ctx), w.w.ctx.frontier());
    assert_eq!(frontier_abi::addr::host_id(129, 0, 0, 1, 0), None);

    // Idempotent; the next ring waits for this seed.
    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::AlreadyDone as u32));
    assert_eq!(w.request(130), Err(E::SeedNotReady as u32));
    assert_eq!(w.open_province(129, 0), Err(E::SeedNotReady as u32));

    // The consume: a wrong round before any signature; the right round with
    // no verifiable signature fails closed on the host (`Crypto`), and the
    // record is untouched either way.
    assert_eq!(w.consume(129, rec.round + 1), Err(E::WrongRound as u32));
    assert_eq!(w.consume(129, rec.round), Err(E::Crypto as u32));
    assert_eq!(
        w.consume(130, 1),
        Err(E::BadAccount as u32),
        "no such record"
    );
    assert_eq!(w.seed_record(FIRST_WIDE_RING), rec);
    w.seed_as_consume_would(FIRST_WIDE_RING, &RING129_SEED);
    let seeded = w.seed_record(FIRST_WIDE_RING);
    assert_eq!(seeded.status, SeedStatus::Seeded);
    assert_eq!(seeded.terrain_seed(), Some(&RING129_SEED));
    assert_eq!(seeded.round, rec.round);
    assert_eq!(w.consume(129, rec.round), Err(E::AlreadyDone as u32));

    // The chain: ring 130 waits a bell after ring 129 opened, then lands
    // with the previous wide seed as its link; ring 131 waits for 130.
    assert_eq!(w.request(130), Err(E::TooEarly as u32));
    let now2 = at_bell(2);
    assert_eq!(w.request(130), Ok(()));
    let r130 = w.seed_record(130);
    assert_eq!((r130.ring, r130.opened_bell, r130.t_open), (130, 2, now2));
    assert!(r130.round > rec.round);
    assert_eq!(w.request(131), Err(E::SeedNotReady as u32));
    w.seed_as_consume_would(130, &RING130_SEED);
    assert_eq!(
        w.request(131),
        Err(E::TooEarly as u32),
        "a bell since 130 opened"
    );
    assert!(records().is_empty());
}

/// The rules configuration through the program: refused for a signer that
/// is not the Season's authority, for an unset or unknown candidate byte
/// and for another table version (nothing created); written once by the
/// authority from its own lamports, read back as written; a second write
/// is `AlreadyDone` and changes nothing.
#[test]
fn wide_land_rules_configuration_is_authority_bound_explicit_and_write_once() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    records();
    assert_eq!(
        w.set_rules(PAYER, RULES),
        Err(E::Auth as u32),
        "not the authority"
    );
    assert_eq!(
        w.set_rules(AUTHORITY, (RULES.0, 0, RULES.2, RULES.3, RULES.4)),
        Err(E::BadData as u32),
        "an unset keep-holder byte is no default"
    );
    assert_eq!(
        w.set_rules(AUTHORITY, (RULES.0, RULES.1, RULES.2, RULES.3, 9)),
        Err(E::BadData as u32),
        "an unknown region byte"
    );
    assert_eq!(
        w.set_rules(AUTHORITY, (RULES.0 + 1, RULES.1, RULES.2, RULES.3, RULES.4)),
        Err(E::BadData as u32),
        "another table version"
    );
    assert!(absent(&w.config()), "no refusal created anything");
    assert!(records().is_empty());

    assert_eq!(w.set_rules(AUTHORITY, RULES), Ok(()));
    let ai = w.config();
    assert_eq!(*ai.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(ai.data_len(), wr::rules_config::SIZE);
    assert_eq!(
        ai.lamports(),
        crate::init::rent(wr::rules_config::SIZE).unwrap()
    );
    let cfg = WideRulesConfig::read(&ai.try_borrow_data().unwrap()).unwrap();
    assert_eq!(cfg.season_id, SEASON_ID);
    assert_eq!(cfg.world, w.world_id());
    assert_eq!(cfg.config_version, wr::WIDE_RULES_CONFIG_VERSION);
    assert_eq!(cfg.keep_holder, KeepHolderRule::MixedInterleaved);
    assert_eq!(cfg.free_city, FreeCityRule::CanonicalHashV1);
    assert_eq!(cfg.camp, CampRule::SortKeyDrawV1);
    assert_eq!(cfg.region, RegionRule::SortKeyHashV1);
    assert_eq!(cfg.authority, AUTHORITY);
    let before = ai.try_borrow_data().unwrap().to_vec();
    assert_eq!(
        w.set_rules(
            AUTHORITY,
            (
                RULES.0,
                KeepHolderRule::OrbitBalanced as u8,
                FreeCityRule::NoFreeCity as u8,
                CampRule::NoCamp as u8,
                RULES.4
            )
        ),
        Err(E::AlreadyDone as u32),
        "write-once"
    );
    assert_eq!(w.config().try_borrow_data().unwrap().to_vec(), before);
    assert!(records().is_empty(), "no PS2 record has an allocated kind");
}

/// The opening through the program. Without the configuration the
/// readiness gate refuses with nothing written. With it, a whole wide
/// province is created from the wedge fund: the wide terrain kernel's
/// bytes, a zero legacy identity, the keep on the deployed symmetric tile
/// held by the configured candidate nation, the configured Free City and
/// camp, the deployed mirror and bells, the fund's and the seed's
/// counters; no record; a second opening is `AlreadyDone`; a fund short of
/// the rent is `Insufficient` with nothing created and no counter moved;
/// two ring neighbours of one wedge are held by different nations.
#[test]
fn wide_land_open_province_creates_a_whole_province_only_under_an_explicit_configuration() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    w.w.fold();
    assert_eq!(w.request(FIRST_WIDE_RING), Ok(()));
    w.seed_as_consume_would(FIRST_WIDE_RING, &RING129_SEED);
    records();
    let funds_before = w.fund_lamports();
    let payer_before = w.w.payer.lamports();
    let seed_before = w.seed_record(FIRST_WIDE_RING);
    let frontier_before = w.w.frontier_state();

    // Without a configuration: the validations, then the gate.
    assert_eq!(w.open_province(128, 0), Err(E::BadData as u32), "the disk");
    assert_eq!(
        w.open_province((1 << 62) + 1, 0),
        Err(E::BadData as u32),
        "past the bound"
    );
    assert_eq!(
        w.open_province(130, 0),
        Err(E::SeedNotReady as u32),
        "no seed"
    );
    assert_eq!(
        w.open_province_with_fund(129, 0, 1),
        Err(E::BadAddress as u32),
        "another wedge's fund"
    );
    for (p, q) in [(129i64, 0i64), (-129, 129), (0, -129), (65, -129)] {
        assert_eq!(
            w.open_province(p, q),
            Err(E::NotImplemented as u32),
            "({p}, {q}): no configuration, no rule"
        );
        assert!(
            absent(&w.province(c(p, q))),
            "({p}, {q}): no account created"
        );
    }
    assert_eq!(
        WideProvince::open(
            w.world_id(),
            SEASON_ID,
            c(129, 0),
            &seed_before,
            &WideRules::UNDECIDED,
            1,
            0
        ),
        Err(wl::LandError::NotReady {
            missing: readiness::REQUIRED
        }),
        "the gate names every undecided rule"
    );
    assert_eq!(w.fund_lamports(), funds_before, "no fund lamport moved");
    assert_eq!(w.w.payer.lamports(), payer_before);
    assert_eq!(w.seed_record(FIRST_WIDE_RING), seed_before);
    assert!(records().is_empty());

    // The configuration (the authority's, a test choice of candidates).
    assert_eq!(w.set_rules(AUTHORITY, RULES), Ok(()));
    records();

    // The opening of (129, 0), wedge 0, from wedge 0's fund.
    let coord = c(129, 0);
    let rent = crate::init::rent(wl::province::SIZE).unwrap();
    assert_eq!(w.open_province(129, 0), Ok(()));
    let ai = w.province(coord);
    assert_eq!(*ai.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(ai.data_len(), wl::province::SIZE);
    assert_eq!(ai.lamports(), rent);
    let funds = w.fund_lamports();
    assert_eq!(funds[0], funds_before[0] - rent, "the wedge fund paid");
    assert_eq!(&funds[1..], &funds_before[1..]);
    assert_eq!(w.w.payer.lamports(), payer_before, "not the payer");
    let pd = w.province_data(coord);
    // The identity: the record model reads it back; the legacy prefix
    // identity is zero.
    let p = WideProvince::read(&pd).unwrap();
    assert_eq!(p.coord, coord);
    assert_eq!((p.wedge, p.readiness), (0, readiness::REQUIRED));
    assert_eq!(p.region, wr::wide_region(coord));
    assert_eq!(p.season_id, SEASON_ID);
    assert_eq!(p.world, w.world_id());
    assert_eq!(p.seed_round, seed_before.round);
    assert_eq!(p.ring_seed, RING129_SEED);
    assert_eq!(p.funded_lamports, rent);
    assert_eq!(p.opened_bell, 1);
    assert_eq!(
        (
            rd_i16(&pd, PV::P),
            rd_i16(&pd, PV::Q),
            rd_u16(&pd, PV::RING)
        ),
        (0, 0, 0)
    );
    assert_eq!(pd[PV::WEDGE], 0);
    assert_eq!(pd[PV::REGION], wr::wide_region(coord));
    // The terrain is the wide kernel's over the ring seed, byte for byte.
    let t = generate_province_wide(&RING129_SEED, 129, 0).unwrap();
    let mut want = vec![0u8; wl::province::SIZE];
    encode_terrain(&t, &mut want).unwrap();
    assert_eq!(&pd[TERRAIN_BLOCK], &want[TERRAIN_BLOCK]);
    assert_eq!(pd[PV::SITE_COUNT], t.site_count);
    assert!(t.site_count > 0, "a ring-129 province has sites");
    assert_ne!(
        &pd[TERRAIN_BLOCK],
        &{
            let mut legacy = vec![0u8; wl::province::SIZE];
            encode_terrain(
                &generate_province(&RING129_SEED, ProvinceCoord::new(129, 0)),
                &mut legacy,
            )
            .unwrap();
            legacy
        }[TERRAIN_BLOCK],
        "not the legacy noise under another name"
    );
    // The bells.
    assert_eq!(rd_u32(&pd, PV::RESOLVED_NEXT), 1);
    assert_eq!(rd_u32(&pd, PV::OPENED_BELL), 1);
    assert_eq!(rd_u32(&pd, PV2::SCORE_NEXT_BELL), 1);
    // The keep: the deployed symmetric tile, the candidate holder, the
    // season's home guard, never heartland-safe.
    let k = read_keep(&pd).unwrap().expect("a keep");
    assert_eq!(
        k.holder,
        mixed_home_nation(coord, &GENESIS_SEED).unwrap(),
        "the configured candidate"
    );
    assert_eq!(
        Some(k.tile),
        kkeep::keep_tile(&t, &t.sites, t.site_count, 0)
    );
    assert_eq!(k.troops, w.w.cq.keep_home_guard);
    assert!(!k.heartland_safe);
    assert_eq!((k.since_bell, k.gen, k.progress), (1, 0, 0));
    // The Free City on the candidate's site, every other site free and
    // neutral, no site used.
    let fc = wr::wide_free_city_site(&RING129_SEED, coord, t.site_count) as usize;
    assert!(fc < t.site_count as usize);
    for i in 0..PV::SITES_N {
        let o = PV::site(i);
        if i == fc {
            assert_eq!(pd[o + SM2::STATE], SM2::STATE_FREE_CITY);
            assert_eq!(
                rd_u32(&pd, o + SM2::GARRISON),
                w.w.cq.free_city_garrison * MILLI as u32
            );
        } else {
            assert_eq!(pd[o + SM::STATE], SM::STATE_FREE, "site {i}");
        }
        assert_eq!(pd[o + SM::FACTION], NEUTRAL);
        assert_eq!(rd_u32(&pd, o + SM::PEND0_BELL), SM::NO_BELL);
    }
    assert_eq!(pd[PV::N_SITES_USED], 0);
    // The camp: the candidate's draw, off the keep and the sites.
    let camp = wr::wide_initial_camp(&RING129_SEED, coord, &t, 0, Some(k.tile)).unwrap();
    assert_eq!(pd[PV::CAMP + CP::TILE], camp.tile);
    assert_eq!(pd[PV::CAMP + CP::STATE], CP::STATE_PRESENT);
    assert_eq!(rd_u32(&pd, PV::CAMP + CP::TROOPS), camp.troops);
    assert_eq!(rd_u32(&pd, PV::CAMP + CP::GEN), 1);
    assert_eq!(rd_u32(&pd, PV::CAMP + CP::NEXT_CHECK_DAY), 1);
    assert_ne!(camp.tile, k.tile);
    assert!(!t.is_site(camp.tile));
    // The fund's counters and the wide seed's count; no Frontier write; no
    // record.
    let fd = w.w.fund_data(0);
    assert_eq!(
        rd_u32(&fd, PF::OPEN_SITES),
        FUND_OPEN_SITES + t.site_count as u32
    );
    assert_eq!(rd_u32(&fd, PF::PROVINCES_OPENED), 1);
    assert_eq!(rd_u32(&fd, PF::PROVINCES_FUNDED), 1);
    assert_eq!(Ro(&fd).u64(PF::SPENT_TOTAL).unwrap(), rent);
    let seed_after = w.seed_record(FIRST_WIDE_RING);
    assert_eq!(seed_after.provinces_created, 1);
    assert_eq!(
        WideRingSeed {
            provinces_created: 0,
            ..seed_after
        },
        seed_before,
        "nothing else of the seed changed"
    );
    assert_eq!(w.w.frontier_state(), frontier_before);
    assert!(records().is_empty(), "no PS2 record has an allocated kind");
    assert_eq!(w.open_province(129, 0), Err(E::AlreadyDone as u32));

    // Atomicity: a wedge fund short of the rent creates nothing and moves
    // no counter.
    let other = c(129, -1);
    let wedge = other.wedge().unwrap();
    let floor = crate::init::rent(PF::SIZE).unwrap();
    let fund_before = w.w.fund(wedge).lamports();
    let fund_data_before = w.w.fund_data(wedge);
    {
        let f = w.w.fund(wedge);
        **f.try_borrow_mut_lamports().unwrap() = floor + rent - 1;
    }
    assert_eq!(
        w.open_province(other.p(), other.q()),
        Err(E::Insufficient as u32)
    );
    assert!(absent(&w.province(other)), "nothing created");
    assert_eq!(w.w.fund(wedge).lamports(), floor + rent - 1);
    assert_eq!(w.w.fund_data(wedge), fund_data_before);
    assert_eq!(w.seed_record(FIRST_WIDE_RING).provinces_created, 1);
    assert!(records().is_empty());
    {
        let f = w.w.fund(wedge);
        **f.try_borrow_mut_lamports().unwrap() = fund_before;
    }

    // Counter overflow must refuse before allocation/rent transfer, too.
    for off in [
        PF::OPEN_SITES,
        PF::PROVINCES_OPENED,
        PF::PROVINCES_FUNDED,
        PF::SPENT_TOTAL,
    ] {
        let f = w.w.fund(wedge);
        {
            let mut data = f.try_borrow_mut_data().unwrap();
            if off == PF::SPENT_TOTAL {
                crate::layout::Rw(&mut data).set_u64(off, u64::MAX).unwrap();
            } else {
                crate::layout::Rw(&mut data).set_u32(off, u32::MAX).unwrap();
            }
        }
        let before = w.w.fund_data(wedge);
        assert!(w.open_province(other.p(), other.q()).is_err());
        assert!(absent(&w.province(other)));
        assert_eq!(f.lamports(), fund_before);
        assert_eq!(w.w.fund_data(wedge), before);
        assert_eq!(w.seed_record(FIRST_WIDE_RING).provinces_created, 1);
        f.try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&fund_data_before);
    }

    // The mixing: the next province of wedge 0 in ring order, (128, 1),
    // opens from the same seed and fund, and its keep is another nation's
    // (the interleaved candidate changes nation at every step).
    let next = c(128, 1);
    assert_eq!((next.ring(), next.wedge()), (129, Some(0)));
    assert_eq!(w.open_province(128, 1), Ok(()));
    let nd = w.province_data(next);
    let nk = read_keep(&nd).unwrap().expect("a keep");
    assert_eq!(nk.holder, mixed_home_nation(next, &GENESIS_SEED).unwrap());
    assert_ne!(nk.holder, k.holder, "one wedge, two nations");
    let nt = generate_province_wide(&RING129_SEED, 128, 1).unwrap();
    assert_eq!(
        Some(nk.tile),
        kkeep::keep_tile(&nt, &nt.sites, nt.site_count, 0)
    );
    assert_eq!(WideProvince::read(&nd).unwrap().coord, next);
    assert_eq!(w.seed_record(FIRST_WIDE_RING).provinces_created, 2);
    assert_eq!(rd_u32(&w.w.fund_data(0), PF::PROVINCES_OPENED), 2);
    assert!(records().is_empty());
}

/// The claim and march gates through the program, over a province the
/// program opened: the deployed FileOutpost prerequisites and the deployed
/// Depart checks run read-only, in their order, and both refuse
/// `NotImplemented` with nothing written.
#[test]
fn wide_land_claim_and_depart_run_the_deployed_checks_then_refuse_and_write_nothing() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    w.ready();
    let coord = c(129, 0);
    assert_eq!(w.open_province(129, 0), Ok(()));
    let t = generate_province_wide(&RING129_SEED, 129, 0).unwrap();
    let fc = wr::wide_free_city_site(&RING129_SEED, coord, t.site_count);
    // A free site of the opened province (not the Free City's).
    let site = (0..t.site_count).find(|s| *s != fc).expect("a free site");
    records();

    // WideClaimSite: the deployed authorization read-only, the land, the
    // slot model, then the anchor rule.
    let (home, nation) = off_wedge_province();
    let a = w.w.member(WALLET_A, nation);
    let placeholder = ProvinceCoord::new(2, 0);
    let citizen_before = w.w.citizen_data(&a);
    let province_before = w.province_data(coord);
    let payer_before = w.w.payer.lamports();
    assert_eq!(
        w.claim(&a, WALLET_B, coord, site, 2, placeholder, 0),
        Err(E::Auth as u32),
        "the deployed player authorization: not the wallet, not a session"
    );
    assert_eq!(
        w.claim(&a, a.wallet, c(128, 0), site, 2, placeholder, 0),
        Err(E::BadData as u32),
        "the disk"
    );
    assert_eq!(
        w.claim(&a, a.wallet, c(129, 1), site, 2, placeholder, 0),
        Err(E::BadAccount as u32),
        "no wide province there"
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, 12, 2, placeholder, 0),
        Err(E::BadData as u32),
        "site"
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 1, placeholder, 0),
        Err(E::BadData as u32),
        "slot 1 is the first home's, a heartland rule"
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 4, placeholder, 0),
        Err(E::BadData as u32)
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 3, placeholder, 0),
        Err(E::TicketState as u32),
        "slot 2 is the lowest free slot (the deployed outpost slot rule)"
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 2, placeholder, 0),
        Err(crate::CqError::OutpostRule.code()),
        "no first home to anchor an outpost"
    );
    // A slot already bound to a wide holding is taken.
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::bind(&mut cd, 2).unwrap();
    }
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 2, placeholder, 0),
        Err(E::TicketState as u32)
    );
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::unbind(&mut cd, 2).unwrap();
    }
    assert_eq!(w.w.citizen_data(&a), citizen_before);
    // An NFT resident's Citizen is refused by the wallet form by address
    // (it lives at the resident id's address with a zero wallet); no wide
    // tag is a v2 tag, so ResidentAct cannot route it either.
    let n = w.w.member(WALLET_B, nation);
    {
        let mut cd = n.citizen.try_borrow_mut_data().unwrap();
        assert!(frontier_abi::resident_citizen::mark(&mut cd, &[0x33; 32]));
    }
    let nft_before = w.w.citizen_data(&n);
    assert_eq!(
        w.claim(&n, WALLET_B, coord, site, 2, placeholder, 0),
        Err(E::BadAddress as u32)
    );
    assert_eq!(w.w.citizen_data(&n), nft_before);
    for ix in WideIx::ALL {
        assert!(frontier_abi::v2::Ix::from_tag(ix.tag()).is_none());
    }
    assert_eq!(w.province_data(coord), province_before);
    assert_eq!(w.w.payer.lamports(), payer_before);
    assert!(absent(&w.holding(coord, site)));
    assert!(records().is_empty(), "a refusal logs nothing");

    // A Hamlet first home in the heartland: the deployed prerequisite
    // (Town) and range (3 provinces) refuse.
    assert_eq!(w.w.place_home(&a, home, 0), Ok(()));
    records();
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 2, home, 0),
        Err(crate::CqError::OutpostRule.code())
    );
    // The fixture: that home moved to the rim as a Town with short stores
    // (module doc). The settler cost (1× the base for a second holding)
    // is not affordable: `Insufficient`.
    let rim = w.fixture_rim_home(&a, home, 100 * MILLI);
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 2, rim, 0),
        Err(E::Insufficient as u32),
        "the settler cost from the anchor's stores"
    );
    // The wrong anchor account for the Citizen's slot-1 ref: BadAddress.
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 2, home, 0),
        Err(E::BadAddress as u32)
    );
    // Every prerequisite met: the gate.
    w.set_stores(rim, 0, 1_500 * MILLI);
    let citizen_before = w.w.citizen_data(&a);
    let anchor_before = w.w.holding_data(rim, 0);
    let shard_before = w.w.shard_counts(&a);
    let province_before2 = w.province_data(coord);
    let payer_before2 = w.w.payer.lamports();
    assert_eq!(
        w.claim(&a, a.wallet, coord, site, 2, rim, 0),
        Err(E::NotImplemented as u32),
        "the outpost lifecycle (ticket, draw, escrow, finality) is not ported"
    );
    assert_eq!(
        w.w.citizen_data(&a),
        citizen_before,
        "nothing of the Citizen was written, the bucket included"
    );
    assert_eq!(
        w.w.holding_data(rim, 0),
        anchor_before,
        "the anchor paid nothing"
    );
    assert_eq!(w.w.shard_counts(&a), shard_before);
    assert_eq!(w.province_data(coord), province_before2);
    assert_eq!(w.w.payer.lamports(), payer_before2);
    assert!(absent(&w.holding(coord, site)));
    assert!(records().is_empty());
    // The Free City's site is not free.
    assert_eq!(
        w.claim(&a, a.wallet, coord, fc, 2, rim, 0),
        Err(E::TicketState as u32)
    );
    assert_eq!(w.province_data(coord), province_before2);
    assert_eq!(w.w.payer.lamports(), payer_before2);

    // WideDepart: the host reference, ownership, the deployed Depart
    // checks, then the identity gate. The holding is a fixture (module doc).
    let key = ProvinceKey::new(w.world_id(), coord);
    let host = WideHostRef::new(key, site, 1, 0).unwrap();
    assert_eq!(
        w.depart(&a, host, 10),
        Err(E::BadAccount as u32),
        "no wide holding"
    );
    w.fixture_holding(coord, site, &a.key, 2);
    let holding_before = w.holding(coord, site).try_borrow_data().unwrap().to_vec();
    let b = w.w.member(WALLET_S, 2);
    assert_eq!(
        w.depart(&b, host, 10),
        Err(E::NotOwner as u32),
        "another citizen"
    );
    let wrong_gen = WideHostRef::new(key, site, 2, 0).unwrap();
    assert_eq!(w.depart(&a, wrong_gen, 10), Err(E::NotOwner as u32));
    let other_world = WideHostRef::new(
        ProvinceKey::new(WorldId::new([0x99; 32]).unwrap(), coord),
        site,
        1,
        0,
    )
    .unwrap();
    assert_eq!(w.depart(&a, other_world, 10), Err(E::BadAddress as u32));
    assert_eq!(
        w.depart(&a, host, 1),
        Err(E::ArrivalBell as u32),
        "the deployed arrival window"
    );
    assert_eq!(
        w.depart(&a, host, 10),
        Err(E::NotImplemented as u32),
        "no wider host identity is allocated: no march debit"
    );
    assert_eq!(
        w.holding(coord, site).try_borrow_data().unwrap().to_vec(),
        holding_before,
        "no transit record, no escrow"
    );
    assert_eq!(w.w.citizen_data(&a), citizen_before);
    assert_eq!(w.w.payer.lamports(), payer_before2);
    assert_eq!(
        WideHolding::read(&holding_before).unwrap().host_identity,
        HOST_IDENTITY_UNALLOCATED
    );
    assert!(records().is_empty());
}

/// The one-inventory rule against the deployed writers: a Citizen slot
/// bound to a wide holding is taken for PlaceHome (`TicketState` through
/// `dispatch`), skipped by the deployed free-slot rule, unusable for the
/// deployed host-id codec, and free again after the unbind.
#[test]
fn wide_land_marked_slot_is_taken_for_the_deployed_writers_until_unbound() {
    let _g = begin();
    at_bell(1);
    let mut w = World::new();
    let (c, nation) = off_wedge_province();
    let a = w.member(WALLET_A, nation);
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::bind(&mut cd, 2).unwrap();
        assert_eq!(
            wh::bindings_of(&cd),
            Ok([
                wh::SlotBinding::Empty,
                wh::SlotBinding::Wide,
                wh::SlotBinding::Empty
            ])
        );
        assert_eq!(cd[C::HOLDINGS_N], 1);
        let g2 = cd[C2::holding_of_slot(2) + HR::GEN];
        let g3 = cd[C2::holding_of_slot(3) + HR::GEN];
        assert_eq!(C2::lowest_free_slot(cd[C2::SLOTS], g2, g3), Some(3));
        assert_eq!(
            crate::proc::citizen::home_entitlement(&cd),
            Err(E::TicketState.into())
        );
        assert_eq!(
            frontier_abi::addr::host_id(
                wh::WIDE_SLOT_MARKER.p as i32,
                wh::WIDE_SLOT_MARKER.q as i32,
                wh::WIDE_SLOT_MARKER.site,
                wh::WIDE_SLOT_MARKER.gen,
                0
            ),
            None
        );
    }
    // The deployed PlaceHome, through dispatch: the slot is taken.
    assert_eq!(w.place_home(&a, c, 0), Err(E::TicketState as u32));
    assert!(records().is_empty());
    assert_eq!(w.province_data(c)[PV::N_SITES_USED], 0);
    // After the unbind the same first home lands.
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::unbind(&mut cd, 2).unwrap();
        assert_eq!(cd[C::HOLDINGS_N], 0);
        assert_eq!(cd[C2::holding_of_slot(2) + HR::GEN], C2::EMPTY_GEN);
    }
    assert_eq!(w.place_home(&a, c, 0), Ok(()));
    assert_eq!(records().len(), 1);
    let cd = w.citizen_data(&a);
    assert_eq!(cd[C::HOLDINGS_N], 1);
    assert_eq!(
        wh::bindings_of(&cd).unwrap()[0],
        wh::SlotBinding::Legacy(wh::HoldingRef {
            p: c.p as i16,
            q: c.q as i16,
            site: 0,
            gen: 1
        })
    );
    // A legacy first home in slot 1 and a wide binding in slot 2 are one
    // inventory of two; slot 3 stays the deployed free slot.
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::bind(&mut cd, 2).unwrap();
        assert_eq!(cd[C::HOLDINGS_N], 2);
        let g2 = cd[C2::holding_of_slot(2) + HR::GEN];
        let g3 = cd[C2::holding_of_slot(3) + HR::GEN];
        assert_eq!(C2::lowest_free_slot(cd[C2::SLOTS], g2, g3), Some(3));
        assert_eq!(wh::bind(&mut cd, 2), Err(wh::HoldingError::SlotTaken(2)));
        wh::bind(&mut cd, 3).unwrap();
        assert_eq!(cd[C::HOLDINGS_N], 3);
        let g2 = cd[C2::holding_of_slot(2) + HR::GEN];
        let g3 = cd[C2::holding_of_slot(3) + HR::GEN];
        assert_eq!(C2::lowest_free_slot(cd[C2::SLOTS], g2, g3), None);
    }
    assert_eq!(
        w.place_home(&a, c, 1),
        Err(E::AlreadyDone as u32),
        "the lifetime grant, as before"
    );
}
