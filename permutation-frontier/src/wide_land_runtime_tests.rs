//! Key-free host harness of the **experimental wide land write path**
//! (`wide-world-experimental`), a child of `map_growth_runtime_tests` so
//! it shares that module's accounts, syscall stubs, clock and serial lock.
//! Filter: `map_growth_runtime_tests::wide_land::`.
//!
//! What it shows, through the program's real `dispatch`:
//!
//! - **the seed provenance writes** (0xD6, 0xD7): a wide ring seed for ring
//!   129 requested after the deployed OpenRing gates (the legacy RingSeed
//!   of ring 128 seeded, a bell since it opened, θ on the folded Frontier,
//!   every wedge fund at `d × rent`), its round the kernel's
//!   `ring_seed_round` of the request time, paid by the payer; the chain
//!   to ring 130; every refusal (the disk, a skipped ring, an unseeded
//!   previous ring, a duplicate, a wrong round, a Season of another program
//!   version, θ unmet, a short fund); the consume refusing a wrong round
//!   before the signature and failing closed on the host, where no
//!   quicknet signature can be verified;
//! - **the three readiness gates** (0xD8, 0xD9, 0xDA): WideOpenProvince,
//!   WideClaimSite and WideDepart run the implemented preliminary validations (season version, coordinate, seed, fund, absence;
//!   the deployed player authorization read-only; the one-inventory slot
//!   model; the host reference and ownership), then refuse
//!   `NotImplemented` (99) with **no byte written and no lamport moved**:
//!   the fund, the Citizen (bucket included), the seed's count and the
//!   absent target are compared before and after;
//! - **the one-inventory rule against the deployed writers**: with a
//!   Citizen slot bound to a wide holding (the marker ref), the deployed
//!   PlaceHome refuses `TicketState` through `dispatch`, the deployed
//!   free-slot rule skips the slot, and the deployed host-id codec refuses
//!   the marker; after the unbind the same PlaceHome succeeds;
//! - **regression**: the deployed OpenRing and OpenProvince still refuse
//!   ring 129, and no wide address equals a legacy one.
//!
//! **Limits.** As the parent's: literal addresses, public PDA and
//! with-seed arithmetic only, no keypair and no signature (`is_signer` is
//! set by the test); ConsumeRingSeed's BLS verification cannot pass on the
//! host, so the growth tests write the seed as the verified instruction
//! would ([`Wide::seed_as_consume_would`], through the record model); the
//! wide province and holding **fixtures** are written by the test under
//! decided rules the program does not have (a model exercise that lets
//! the claim and depart gates be reached; no build can create them); a
//! refused instruction keeps what it wrote before the refusal, so every
//! refusal here is asserted to have written nothing.

use super::*;
use frontier_abi::ix::{HINTS_LEN, SEAL_LEN};
use frontier_abi::world_index::holding::{self as wh, WideHolding, HOST_IDENTITY_UNALLOCATED};
use frontier_abi::world_index::land::{
    self as wl, readiness, CampDecision, Decision, SeedStatus, WideProvince, WideRingSeed,
    WideRules, FIRST_WIDE_RING,
};
use frontier_abi::world_index::wide_ix::{self as wix, WideIx};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};

/// The literal seed the legacy RingSeed of ring 128 carries in the
/// pre-state (as OpenRing(128) and ConsumeRingSeed left it).
const RING128_SEED: [u8; 32] = [0x80; 32];
/// The literal seed the test gives wide ring 129, as the verified consume
/// would (module doc).
const RING129_SEED: [u8; 32] = [0x81; 32];
const RING130_SEED: [u8; 32] = [0x82; 32];

/// The world at the legacy rim plus the wide accounts a test touches.
struct Wide {
    w: World,
    seeds: HashMap<u64, AccountInfo<'static>>,
    provinces: HashMap<(i64, i64), AccountInfo<'static>>,
    holdings: HashMap<(i64, i64, u8), AccountInfo<'static>>,
}

fn c(p: i64, q: i64) -> WideCoord {
    WideCoord::checked(p, q).unwrap()
}

impl Wide {
    /// A season extended to the program's hard maximum with every legacy
    /// ring opened (`rings_opened` 129, `r_max_ext` 128) and the legacy
    /// RingSeed of ring 128 present and seeded at bell 0: the state
    /// OpenRing(128) and ConsumeRingSeed(128) leave, written as pre-state.
    fn rim() -> Wide {
        let mut w = World::with(Setup {
            r_max: 4,
            genesis_ring: 2,
            ceiling: R_MAX_HARD,
            rings_opened: 129,
            r_max_ext: R_MAX_HARD,
        });
        w.set_shard_homes(0, 0, 0, WEDGE0_HOMES);
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

    /// Wide province `coord`: absent at its canonical draft address.
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

    /// **Fixture** (module doc): a wide province of `coord` as a decided
    /// opening would write its identity, over a zero game state, present
    /// and program-owned. The program cannot create one today.
    fn fixture_province(&mut self, coord: WideCoord) -> AccountInfo<'static> {
        let seed = self.seed_record(coord.ring());
        let rules = WideRules {
            keep_holder: Decision::Decided(1),
            free_city_site: Decision::Decided(None),
            camp: Decision::Decided(Some(CampDecision {
                tile: 20,
                troops: 200,
            })),
            region: Decision::Decided(5),
        };
        let p = WideProvince::open(self.world_id(), SEASON_ID, coord, &seed, &rules, 1, 0)
            .unwrap()
            .province;
        let mut d = vec![0u8; wl::province::SIZE];
        p.write_identity(&mut d).unwrap();
        let key = wl::province_address(&self.w.ctx, coord);
        let ai = info(leak(key, PROGRAM, d, 0, BIG), false, true);
        self.provinces.insert((coord.p(), coord.q()), ai.clone());
        ai
    }

    /// **Fixture** (module doc): a wide holding of `(coord, site)` owned by
    /// `owner` in `slot`, as a decided claim would write its identity (gen
    /// 1, host identity unallocated, tile 10, final), present and
    /// program-owned.
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

    /// 0xD8 WideOpenProvince(P, Q) by the payer, the wedge fund writable.
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
            self.w.system.clone(),
        ];
        run(&a, &wix::OpenProvince { p, q }.to_bytes())
    }

    /// 0xD9 WideClaimSite by `actor` for the member's Citizen.
    fn claim(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        coord: WideCoord,
        site: u8,
        slot: u8,
    ) -> Result<(), u32> {
        let a = [
            wallet(actor, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.province(coord),
            self.holding(coord, site),
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

/// The three readiness gates through the program: WideOpenProvince,
/// WideClaimSite and WideDepart run their validations in the deployed
/// order and refuse `NotImplemented` with nothing written.
#[test]
fn wide_land_open_claim_and_depart_refuse_not_implemented_and_write_nothing() {
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

    // WideOpenProvince: the validations, then the rules gate.
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
            "({p}, {q}): the keep-holder, Free City, camp and region rules are undecided"
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
    assert_eq!(
        w.seed_record(FIRST_WIDE_RING),
        seed_before,
        "the seed's count is unchanged"
    );
    assert!(records().is_empty());

    // WideClaimSite: the deployed authorization read-only, the province,
    // the site, the slot model, then the claim-rule gate. The province is a
    // fixture (module doc).
    let a = w.w.member(WALLET_A, 2);
    let coord = c(129, 0);
    assert_eq!(
        w.claim(&a, a.wallet, coord, 3, 2),
        Err(E::BadAccount as u32),
        "no wide province exists"
    );
    w.fixture_province(coord);
    let citizen_before = w.w.citizen_data(&a);
    assert_eq!(
        w.claim(&a, WALLET_B, coord, 3, 2),
        Err(E::Auth as u32),
        "the deployed player authorization: not the wallet, not a session"
    );
    assert_eq!(
        w.claim(&a, a.wallet, c(128, 0), 3, 2),
        Err(E::BadData as u32)
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, 12, 2),
        Err(E::BadData as u32),
        "site"
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, 3, 1),
        Err(E::BadData as u32),
        "slot 1 is the first home's, a heartland rule"
    );
    assert_eq!(w.claim(&a, a.wallet, coord, 3, 4), Err(E::BadData as u32));
    assert_eq!(
        w.claim(&a, a.wallet, coord, 3, 2),
        Err(E::NotImplemented as u32),
        "the claim rule is undecided"
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, 3, 3),
        Err(E::NotImplemented as u32)
    );
    assert_eq!(
        w.w.citizen_data(&a),
        citizen_before,
        "nothing of the Citizen was written, the bucket included"
    );
    assert!(absent(&w.holding(coord, 3)));
    // a slot already bound to a wide holding is taken
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::bind(&mut cd, 2).unwrap();
    }
    assert_eq!(
        w.claim(&a, a.wallet, coord, 3, 2),
        Err(E::TicketState as u32)
    );
    assert_eq!(
        w.claim(&a, a.wallet, coord, 3, 3),
        Err(E::NotImplemented as u32)
    );
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        wh::unbind(&mut cd, 2).unwrap();
    }
    assert_eq!(w.w.citizen_data(&a), citizen_before);

    // WideDepart: the host reference, ownership, then the identity gate.
    // The holding is a fixture (module doc).
    let key = ProvinceKey::new(w.world_id(), coord);
    let host = WideHostRef::new(key, 3, 1, 0).unwrap();
    assert_eq!(
        w.depart(&a, host, 10),
        Err(E::BadAccount as u32),
        "no wide holding"
    );
    w.fixture_holding(coord, 3, &a.key, 2);
    let holding_before = w.holding(coord, 3).try_borrow_data().unwrap().to_vec();
    let b = w.w.member(WALLET_B, 2);
    assert_eq!(
        w.depart(&b, host, 10),
        Err(E::NotOwner as u32),
        "another citizen"
    );
    let wrong_gen = WideHostRef::new(key, 3, 2, 0).unwrap();
    assert_eq!(w.depart(&a, wrong_gen, 10), Err(E::NotOwner as u32));
    let other_world = WideHostRef::new(
        ProvinceKey::new(WorldId::new([0x99; 32]).unwrap(), coord),
        3,
        1,
        0,
    )
    .unwrap();
    assert_eq!(w.depart(&a, other_world, 10), Err(E::BadAddress as u32));
    assert_eq!(
        w.depart(&a, host, 10),
        Err(E::NotImplemented as u32),
        "no wider host identity is allocated: no march debit"
    );
    assert_eq!(
        w.holding(coord, 3).try_borrow_data().unwrap().to_vec(),
        holding_before,
        "no transit record, no escrow"
    );
    assert_eq!(w.w.citizen_data(&a), citizen_before);
    assert_eq!(
        WideHolding::read(&holding_before).unwrap().host_identity,
        HOST_IDENTITY_UNALLOCATED
    );
    assert!(records().is_empty());
    // The draft tags are no v2 instruction: a default build refuses them.
    for ix in WideIx::ALL {
        assert!(frontier_abi::v2::Ix::from_tag(ix.tag()).is_none());
    }
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
