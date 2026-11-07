//! Key-free host harness of the **experimental wide land write path**
//! (`wide-world-experimental`), a child of `map_growth_runtime_tests` so
//! it shares that module's accounts, syscall stubs, clock and serial lock.
//! Filter: `map_growth_runtime_tests::wide_land::`.
//!
//! What it shows, through the program's real `dispatch`:
//!
//! - **the seed provenance writes** (0xD6, 0xD7) and **the rules
//!   configuration** (0xDB), as before;
//! - **the opening** (0xD8): a whole wide province under the explicit
//!   configuration, nothing without it;
//! - **the wide outpost ticket** (0xD9, 0xDC, 0xDF): the deployed
//!   FileOutpost prerequisites in order; a filed ticket (the record holding
//!   the wide Holding's rent, the Citizen's marker, the province's cohort,
//!   the anchor's settler cost and its `HARVEST`); every deployed ticket
//!   path refusing the marker (the deployed SettleTicket explicitly,
//!   CloseCitizen explicitly); the settle: a stale `k`, the seed not
//!   staged, then **fresh** (a provisional wide holding from the record's
//!   escrow, the slot bound, the cohort settled, the record kept Settled
//!   with the escrow consumed), replay refused, finality refused before
//!   its time and applied after it, a refile reusing the record, a ticket
//!   **expired** after 24 bells with the wide rent **retained** in the
//!   record as the deployed escrow is; two tickets of one cohort on one
//!   site, the lower score **displaced** (the loser unbound and refunded
//!   from the winner's escrow, the holding rewritten at the next
//!   generation), a third taken with its rent retained; the refusals that
//!   must precede every write (a full cohort, a reservation on the
//!   ticket's slot, a marker disagreeing with its record, a counter at its
//!   maximum, a CPI that cannot allocate) under a snapshot-and-restore
//!   executor;
//! - **the escrow retention** (0xD9, 0xDC, 0xDE, the deployed FileOutpost /
//!   SettleTicket / CloseCitizen rules over the record): nothing back to
//!   the funder while the Season runs; a refile by another payer over the
//!   retained rent tops up nothing and leaves the funder; a win's holding
//!   is paid for by the funder, not the refiler; a refile over an empty
//!   escrow tops up the wide rent and re-attributes the funder; the same
//!   payer again tops up nothing; at season end a Settled record closes in
//!   CloseCitizen's shape before or after CloseCitizen (the Citizen
//!   position then absent): the record's rent to its immutable rent payer,
//!   the escrow to its funder, exact balances when the two differ, swapped
//!   recipients, a missing funder and a replay refused;
//! - **the NFT resident** (0xDD): the real resident check (policy, link,
//!   asset owner, holder generation) through the band's own act; a stale
//!   generation, a previous owner and the wallet form refused; a transfer
//!   handing the ticket to the new holder's generation, the retained record
//!   reused by the new holder;
//! - **season end** (0xDE): CloseCitizen refusing while a wide ticket is
//!   pending, the ticket's record returned, then the Citizen closing
//!   (Aborted); Settled records returned under Ended + 72 h and under the
//!   Closed tombstone; a wide holding closed to its rent payer where the
//!   deployed CloseHolding refuses the record;
//! - **the march gate** (0xDA) and **the one-inventory rule** against the
//!   deployed writers, as before.
//!
//! **Limits.** As the parent's: literal addresses, public PDA and
//! with-seed arithmetic only, no keypair and no signature (`is_signer` is
//! set by the test); ConsumeRingSeed's BLS verification cannot pass on the
//! host, so the tests write the seed as the verified instruction would
//! ([`Wide::seed_as_consume_would`]); the **beacon seed of a bell**
//! (`SeedCache` and `BellAnchor`) is staged by the test with a literal seed
//! as the keeper's PostSeed would leave it after a verified round
//! ([`Wide::stage_seed`]); the Season's authority, the candidate bytes,
//! the NFT policy, asset and resident records are literals in the shapes
//! the real programs write (the resident harness's); the Closed tombstone
//! is the Season's first 128 bytes with the Closed status, as CloseSeason
//! leaves it ([`Wide::tombstone`]). **Fixtures** the
//! program cannot create: a final Town first home at ring 128
//! ([`Wide::fixture_rim_home`]: a PlaceHome-written Holding relocated by
//! the test to the rim with stores, standing in for the FileTicket lottery
//! and a Town tier-up that are not run here). The wide holdings the march
//! gate and the closes act on are the program's own, from the settle.
//!
//! **Atomicity.** The runtime reverts a refused transaction; this harness
//! has no rollback of its own. Every wide instruction here runs through
//! [`run_tx`], which snapshots every account's lamports, bytes, length and
//! owner and restores them on a refusal, so a "nothing changed" assertion
//! after a refusal is evidence of all-or-nothing **under the emulation**.
//! Independently, the handlers refuse before their first write for every
//! deterministic error (`proc::wide`), which [`run_tx`] can also witness:
//! it reports whether the restore found anything to undo.

use super::*;
use frontier_abi::conquest_model::read_keep;
use frontier_abi::ix::{HINTS_LEN, SEAL_LEN};
use frontier_abi::resident_auth::Policy;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::world_index::holding::{self as wh, WideHolding, HOST_IDENTITY_UNALLOCATED};
use frontier_abi::world_index::land::{
    self as wl, readiness, SeedStatus, WideProvince, WideRingSeed, WideRules, FIRST_WIDE_RING,
};
use frontier_abi::world_index::placement::mixed_home_nation;
use frontier_abi::world_index::rules::{
    self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule, WideRulesConfig,
};
use frontier_abi::world_index::ticket::{self as wt, CitizenTicket, TicketStatus, WideTicket};
use frontier_abi::world_index::wide_ix::{self as wix};
use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef, WorldId};
use frontier_abi::{resident_binding, resident_citizen, resident_policy};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use permutation_rules::frontier::terrain::wide::generate_province_wide;

use crate::clock::SeasonClock;
use crate::layout::player::accrual as AC;
use crate::layout::{
    bell_anchor as BA, camp as CP, cohort as CO, join_shard2 as JS2, seed_cache as SC,
};
use crate::CqError as CE;

/// The literal seed the legacy RingSeed of ring 128 carries in the
/// pre-state (as OpenRing(128) and ConsumeRingSeed left it).
const RING128_SEED: [u8; 32] = [0x80; 32];
/// The literal seed the test gives wide ring 129, as the verified consume
/// would (module doc).
const RING129_SEED: [u8; 32] = [0x81; 32];
const RING130_SEED: [u8; 32] = [0x82; 32];
/// The literal beacon seed of a bell the test stages (module doc).
const BELL_SEED: [u8; 32] = [0x5a; 32];
/// The Season's authority (a literal; AnnounceSeason stores the creator).
const AUTHORITY: [u8; 32] = [0xaa; 32];
/// A second funder (a literal wallet).
const PAYER2: [u8; 32] = [0xd5; 32];
/// The NFT world's literals, as the resident harness's.
const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
const CORE: [u8; 32] = [0x44; 32];
const COLLECTION: [u8; 32] = [0x55; 32];
const ASSET: [u8; 32] = [0x5b; 32];
const OWNER_A: [u8; 32] = [0xa7; 32];
const OWNER_B: [u8; 32] = [0xb8; 32];
/// The candidate bytes the tests configure (a test choice, not a product
/// decision).
const RULES: (u16, u8, u8, u8, u8) = (
    wr::WIDE_RULES_CONFIG_VERSION,
    KeepHolderRule::MixedInterleaved as u8,
    FreeCityRule::CanonicalHashV1 as u8,
    CampRule::SortKeyDrawV1 as u8,
    RegionRule::SortKeyHashV1 as u8,
);
/// The rim: ring 128, wedge 0.
const RIM: ProvinceCoord = ProvinceCoord { p: 128, q: 0 };

// ------------------------------------------------------------ executor

/// What a refusal left before the restore: `true` when some account's
/// lamports, bytes, length or owner differed from the snapshot (a write the
/// chain would have reverted).
struct Refused {
    code: u32,
    wrote: bool,
}

/// Runs one instruction as a transaction: every account's lamports, data,
/// length and owner are snapshotted first and restored on a refusal, as
/// the runtime reverts a failed transaction. `Err` carries the program code
/// (`u32::MAX` for a non-program error: a refused CPI) and whether the
/// handler had written before refusing.
fn run_tx(accounts: &[AccountInfo<'static>], data: &[u8]) -> Result<(), Refused> {
    let snap: Vec<(AccountInfo<'static>, u64, Vec<u8>, Pubkey)> = accounts
        .iter()
        .map(|a| {
            (
                a.clone(),
                a.lamports(),
                a.try_borrow_data().unwrap().to_vec(),
                *a.owner,
            )
        })
        .collect();
    match crate::dispatch(&Pubkey::new_from_array(PROGRAM), accounts, data) {
        Ok(()) => Ok(()),
        Err(e) => {
            let mut wrote = false;
            for (a, lamports, bytes, owner) in &snap {
                let same = a.lamports() == *lamports
                    && a.data_len() == bytes.len()
                    && *a.try_borrow_data().unwrap() == &bytes[..]
                    && *a.owner == *owner;
                if !same {
                    wrote = true;
                    restore(a, *lamports, bytes, *owner);
                }
            }
            let code = match ProgramError::from(e) {
                ProgramError::Custom(c) => c,
                _ => u32::MAX,
            };
            Err(Refused { code, wrote })
        }
    }
}

/// The emulated revert of one account (module doc): its length through the
/// harness's memory table, as the stub's resize does.
fn restore(a: &AccountInfo<'static>, lamports: u64, bytes: &[u8], owner: Pubkey) {
    **a.try_borrow_mut_lamports().unwrap() = lamports;
    if a.data_len() != bytes.len() {
        let mem = MEMORY.lock().unwrap();
        let &(ptr, cap, _) = mem.as_ref().unwrap().get(&a.key.to_bytes()).unwrap();
        assert!(bytes.len() <= cap);
        // SAFETY: `ptr` is the data start of the leaked buffer `leak` made
        // for this account, of `cap ≥ bytes.len()` bytes; the account's own
        // data slice is replaced below and no other slice of it is alive.
        let s = unsafe { std::slice::from_raw_parts_mut(ptr as *mut u8, bytes.len()) };
        *a.try_borrow_mut_data().unwrap() = s;
    }
    a.try_borrow_mut_data().unwrap().copy_from_slice(bytes);
    if *a.owner != owner {
        assign(a, owner.to_bytes()).unwrap();
    }
}

/// The program code of a refusal, asserting the handler had **not** written
/// before it (the restore found nothing to undo).
fn code(r: Result<(), Refused>) -> Result<(), u32> {
    r.map_err(|e| {
        assert!(
            !e.wrote,
            "code {}: the handler wrote before refusing",
            e.code
        );
        e.code
    })
}

// ------------------------------------------------------------ world

/// The world at the legacy rim plus the wide accounts a test touches.
struct Wide {
    w: World,
    seeds: HashMap<u64, AccountInfo<'static>>,
    provinces: HashMap<(i64, i64), AccountInfo<'static>>,
    holdings: HashMap<(i64, i64, u8), AccountInfo<'static>>,
    tickets: HashMap<[u8; 32], AccountInfo<'static>>,
    wallets: HashMap<[u8; 32], AccountInfo<'static>>,
    beacons: HashMap<(u32, u8), (AccountInfo<'static>, AccountInfo<'static>)>,
    config: Option<AccountInfo<'static>>,
}

/// An NFT resident's Citizen and its proof accounts.
struct Nft {
    m: Member,
    policy: AccountInfo<'static>,
    link: AccountInfo<'static>,
    asset: AccountInfo<'static>,
    resident: AccountInfo<'static>,
    generation: u32,
}

fn c(p: i64, q: i64) -> WideCoord {
    WideCoord::checked(p, q).unwrap()
}

fn pda(seeds: &[&[u8]], program: &[u8; 32]) -> [u8; 32] {
    Pubkey::find_program_address(seeds, &Pubkey::new_from_array(*program))
        .0
        .to_bytes()
}

/// A clone of an account with `is_signer` cleared.
fn unsigned(ai: &AccountInfo<'static>) -> AccountInfo<'static> {
    let mut a = ai.clone();
    a.is_signer = false;
    a
}

/// `PluginHeaderV1` + `PluginRegistryV1` for a frozen Permanent Freeze
/// Delegate and a Permanent Transfer Delegate of `guard` after an AssetV1
/// base ending at `base` (the layout `resident_guard` reads; the resident
/// harness's bytes).
fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(guard);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

fn guard() -> [u8; 32] {
    pda(&[b"collection-authority"], &RESIDENT_PROGRAM)
}

/// A Core AssetV1 owned by `owner`, in the collection, guarded.
fn asset_bytes(owner: &[u8; 32]) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner);
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0);
    let base = a.len();
    a.extend_from_slice(&guarded_tail(base, &guard()));
    a
}

/// The resident program's record of `ASSET` (133 B) at `generation`, no
/// session.
fn resident_bytes(generation: u32) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    r
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
            tickets: HashMap::new(),
            wallets: HashMap::new(),
            beacons: HashMap::new(),
            config: None,
        }
    }

    fn world_id(&self) -> WorldId {
        WorldId::derive_legacy_season(&self.w.ctx.season, &PROGRAM).unwrap()
    }

    fn clock(&self) -> SeasonClock {
        SeasonClock::read(&self.w.season.try_borrow_data().unwrap()).unwrap()
    }

    fn set_status(&self, status: u8) {
        self.w.season.try_borrow_mut_data().unwrap()[S::STATUS] = status;
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

    /// Wide holding `(coord, site)`: absent at its canonical draft address
    /// until the program creates it (`cap` bytes of room).
    fn holding_cap(&mut self, coord: WideCoord, site: u8, cap: usize) -> AccountInfo<'static> {
        let key = wh::holding_address(&self.w.ctx, coord, site);
        self.holdings
            .entry((coord.p(), coord.q(), site))
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], cap, 0), false, true))
            .clone()
    }

    fn holding(&mut self, coord: WideCoord, site: u8) -> AccountInfo<'static> {
        self.holding_cap(coord, site, wh::wide_holding::SIZE)
    }

    fn holding_data(&mut self, coord: WideCoord, site: u8) -> Vec<u8> {
        self.holding(coord, site)
            .try_borrow_data()
            .unwrap()
            .to_vec()
    }

    /// The wide ticket record of `citizen`: absent at its canonical draft
    /// address until the program creates it (`cap` bytes of room).
    fn ticket_cap(&mut self, citizen: &[u8; 32], cap: usize) -> AccountInfo<'static> {
        let key = wt::ticket_address(&self.w.ctx, citizen);
        self.tickets
            .entry(*citizen)
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], cap, 0), false, true))
            .clone()
    }

    fn ticket(&mut self, m: &Member) -> AccountInfo<'static> {
        self.ticket_cap(&m.key, wt::wide_ticket::SIZE)
    }

    /// A persistent literal wallet (a second payer, a funder): writable, a
    /// signer where it pays (`unsigned` where it only receives), `BIG`
    /// lamports.
    fn wallet_of(&mut self, key: [u8; 32]) -> AccountInfo<'static> {
        self.wallets
            .entry(key)
            .or_insert_with(|| wallet(key, true, true, BIG))
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

    /// **Fixture** (module doc): THE anchor and the SeedCache of `(bell,
    /// region)` as the keeper's PostAnchor and PostSeed leave them after a
    /// verified round, with the literal `seed`: the anchor landed at `a`
    /// (inside the bell), the cache's round `S(bell, a)`. Returns `(seed
    /// cache, anchor)` read-only.
    fn stage_seed(
        &mut self,
        bell: u32,
        region: u8,
        seed: &[u8; 32],
    ) -> (AccountInfo<'static>, AccountInfo<'static>) {
        if let Some(pair) = self.beacons.get(&(bell, region)) {
            return pair.clone();
        }
        let c = self.clock();
        let a = GENESIS + 600 * bell as i64 + 100;
        let round = c.seed_round(bell, a);
        let anchor_key = self.w.ctx.bell_anchor(bell, region);
        let mut ad = vec![0u8; K2::BellAnchor.size()];
        assert!(frontier_abi::v2::layout::write_header(
            &mut ad,
            K2::BellAnchor,
            SEASON_ID
        ));
        put(&mut ad, BA::BELL, &bell.to_le_bytes());
        ad[BA::REGION] = region;
        put(&mut ad, BA::ROUND, &round.to_le_bytes());
        put(&mut ad, BA::A, &a.to_le_bytes());
        put(&mut ad, BA::SLOT, &1u64.to_le_bytes());
        let cache_key = self.w.ctx.seed_cache(bell, region, 0);
        let mut cd = vec![0u8; K2::SeedCache.size()];
        assert!(frontier_abi::v2::layout::write_header(
            &mut cd,
            K2::SeedCache,
            SEASON_ID
        ));
        put(&mut cd, SC::BELL, &bell.to_le_bytes());
        cd[SC::REGION] = region;
        cd[SC::NONCE] = 0;
        put(&mut cd, SC::ROUND, &round.to_le_bytes());
        put(&mut cd, SC::SEED, seed);
        put(&mut cd, SC::ANCHOR_KEY, &anchor_key);
        put(&mut cd, SC::A, &a.to_le_bytes());
        let pair = (
            info(leak(cache_key, PROGRAM, cd, 0, BIG), false, false),
            info(leak(anchor_key, PROGRAM, ad, 0, BIG), false, false),
        );
        self.beacons.insert((bell, region), pair.clone());
        pair
    }

    /// `final_ts` the settle of a ticket of `bell` writes: `round_time(S) +
    /// 600` for the staged anchor.
    fn final_ts_of(&self, bell: u32) -> i64 {
        let c = self.clock();
        let a = GENESIS + 600 * bell as i64 + 100;
        c.round_time(c.seed_round(bell, a)) + 600
    }

    /// **Fixture** (module doc): the member's final first home at the rim,
    /// from `template` (a PlaceHome-written Holding's bytes): copied to the
    /// canonical address of `RIM` site `site` with `P`, `Q`, `SITE` and the
    /// owner relocated, the tier raised to Town (the deployed outpost
    /// prerequisite) and every store set to `stores` milli-units; the
    /// legacy Province of the rim mirrors the site as that home; the
    /// Citizen's slot 1 names it, its first-home flags set, one holding.
    /// What a FileTicket won at ring 128 and a Town tier-up would have left.
    fn fixture_rim_home(&mut self, m: &Member, template: &[u8], site: u8, stores: i64) {
        let mut hd = template.to_vec();
        assert_eq!(hd.len(), H::SIZE, "a Holding the program created");
        assert_eq!(hd[H::STATE], H::STATE_FINAL);
        assert_eq!(hd[H::ORDER], 1);
        put(&mut hd, H::P, &(RIM.p as i16).to_le_bytes());
        put(&mut hd, H::Q, &(RIM.q as i16).to_le_bytes());
        hd[H::SITE] = site;
        put(&mut hd, H::OWNER_CITIZEN, &m.key);
        hd[H::TIER] = Tier::Town as u8;
        for r in 0..RESOURCES {
            put(&mut hd, H::store(r) + AC::VALUE, &stores.to_le_bytes());
        }
        let key = self.w.ctx.holding(RIM.p, RIM.q, site);
        let ai = info(leak(key, PROGRAM, hd, 0, BIG), false, true);
        self.w.holdings.insert((RIM.p, RIM.q, site), ai);
        let pv = self.w.province(RIM);
        {
            let mut pd = pv.try_borrow_mut_data().unwrap();
            let o = PV::site(site as usize);
            pd[o + SM::STATE] = SM::STATE_HOLDING;
            pd[o + SM::FACTION] = m.faction;
            pd[o + SM::ORDER] = 1;
            pd[o + SM::GEN] = 1;
            pd[PV::N_SITES_USED] += 1;
        }
        {
            let mut cd = m.citizen.try_borrow_mut_data().unwrap();
            let o = C2::holding_of_slot(1);
            put(&mut cd, o + HR::P, &(RIM.p as i16).to_le_bytes());
            put(&mut cd, o + HR::Q, &(RIM.q as i16).to_le_bytes());
            cd[o + HR::SITE] = site;
            cd[o + HR::GEN] = 1;
            cd[C::FLAGS] |= C::FLAG_FIRST_HOLDING_FINAL | C::FLAG_HOME_GRANTED;
            cd[C::HOLDINGS_N] = 1;
        }
    }

    /// Every store of the legacy Holding at `(RIM, site)` set to `stores`
    /// milli-units (a fixture edit).
    fn set_stores(&mut self, site: u8, stores: i64) {
        let ai = self.w.holding(RIM, site);
        let mut hd = ai.try_borrow_mut_data().unwrap();
        for r in 0..RESOURCES {
            put(&mut hd, H::store(r) + AC::VALUE, &stores.to_le_bytes());
        }
    }

    /// An NFT resident's Citizen of `faction` (the resident id's address, a
    /// zero wallet, `resident_citizen::mark`), its policy, link, asset
    /// (owned by `owner`, guarded) and resident record (generation 0), in
    /// the shapes the real programs write.
    fn nft(&mut self, faction: u8, owner: [u8; 32]) -> Nft {
        let shard_i = join_shard_of(&ASSET);
        let key = self
            .w
            .ctx
            .citizen_by_tag15(&resident_citizen::resident_tag15(&ASSET));
        let mut d = citizen_bytes(&key, &[0; 32], faction, shard_i);
        assert!(resident_citizen::mark(&mut d, &ASSET));
        self.w.shard(faction, shard_i);
        let policy = Policy {
            core_program: CORE,
            resident_program: RESIDENT_PROGRAM,
            collection: COLLECTION,
            guard_authority: guard(),
        };
        let mut pd = vec![0u8; resident_policy::LEN];
        assert!(resident_policy::write_once(&mut pd, &policy));
        let resident_key = pda(&[b"resident", &ASSET], &RESIDENT_PROGRAM);
        let mut ld = vec![0u8; resident_binding::LEN];
        assert!(resident_binding::write_once(
            &mut ld,
            &resident_binding::Record {
                asset: ASSET,
                resident: resident_key,
                citizen: key,
            }
        ));
        Nft {
            m: Member {
                wallet: [0; 32],
                faction,
                shard_i,
                key,
                citizen: info(leak(key, PROGRAM, d, 0, BIG), false, true),
            },
            policy: info(
                leak(
                    pda(&[b"nft-resident-policy"], &PROGRAM),
                    PROGRAM,
                    pd,
                    0,
                    BIG,
                ),
                false,
                false,
            ),
            link: info(
                leak(
                    pda(&[b"nft-citizen-link", &self.w.ctx.season, &ASSET], &PROGRAM),
                    PROGRAM,
                    ld,
                    0,
                    BIG,
                ),
                false,
                false,
            ),
            asset: info(leak(ASSET, CORE, asset_bytes(&owner), 0, BIG), false, false),
            resident: info(
                leak(resident_key, RESIDENT_PROGRAM, resident_bytes(0), 0, BIG),
                false,
                false,
            ),
            generation: 0,
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
        code(run_tx(&a, &wix::RequestRingSeed { ring }.to_bytes()))
    }

    /// 0xD7 WideConsumeRingSeed by the payer as fee payer.
    fn consume(&mut self, ring: u64, round: u64) -> Result<(), u32> {
        let a = [self.w.payer.clone(), self.w.season.clone(), self.seed(ring)];
        code(run_tx(
            &a,
            &wix::ConsumeRingSeed {
                ring,
                round,
                sig48: [0u8; 48],
                hints: [0u8; HINTS_LEN],
            }
            .to_bytes(),
        ))
    }

    /// The two fields the verified consume writes (the seed, the status),
    /// through the record model, because the host cannot verify a
    /// quicknet signature and no test may sign one (module doc).
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
        code(run_tx(
            &a,
            &wix::SetRules {
                config_version: r.0,
                keep_holder: r.1,
                free_city: r.2,
                camp: r.3,
                region: r.4,
            }
            .to_bytes(),
        ))
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
        code(run_tx(&a, &wix::OpenProvince { p, q }.to_bytes()))
    }

    /// The account list of 0xD9 WideClaimSite for the member: `payer` pays;
    /// the anchor is the legacy Holding at `(RIM, anchor_site)`; the
    /// previous pair is `prev` (a wide holding and its province for a
    /// slot-3 claim) or the anchor pair again.
    #[allow(clippy::too_many_arguments)]
    fn file_accounts(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        coord: WideCoord,
        anchor_site: u8,
        payer: AccountInfo<'static>,
        prev: Option<(WideCoord, u8)>,
    ) -> Vec<AccountInfo<'static>> {
        let anchor_holding = self.w.holding(RIM, anchor_site);
        let anchor_province = with_writable(&self.w.province(RIM), false);
        let (prev_h, prev_p) = match prev {
            Some((pc, ps)) => (
                self.holding(pc, ps),
                with_writable(&self.province(pc), false),
            ),
            None => (anchor_holding.clone(), anchor_province.clone()),
        };
        vec![
            wallet(actor, true, false, 0),
            payer,
            self.w.season.clone(),
            m.citizen.clone(),
            with_writable(&self.w.frontier, false),
            self.province(coord),
            self.ticket(m),
            with_writable(&anchor_holding, true),
            anchor_province,
            with_writable(&prev_h, true),
            prev_p,
            self.w.system.clone(),
        ]
    }

    /// 0xD9 WideClaimSite (the filing) by `actor` for the member, paid by
    /// the payer, anchored at `(RIM, anchor_site)`.
    #[allow(clippy::too_many_arguments)]
    fn file(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        coord: WideCoord,
        site: u8,
        slot: u8,
        anchor_site: u8,
        payer: AccountInfo<'static>,
        prev: Option<(WideCoord, u8)>,
    ) -> Result<(), Refused> {
        let a = self.file_accounts(m, actor, coord, anchor_site, payer, prev);
        run_tx(
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

    /// 0xDD WideResidentAct(generation, WideClaimSite) by `actor` for the
    /// NFT Citizen, the four proof accounts appended.
    #[allow(clippy::too_many_arguments)]
    fn act_file(
        &mut self,
        n: &Nft,
        actor: [u8; 32],
        generation: u32,
        coord: WideCoord,
        site: u8,
        slot: u8,
        anchor_site: u8,
        prev: Option<(WideCoord, u8)>,
    ) -> Result<(), Refused> {
        let payer = self.w.payer.clone();
        let mut a = self.file_accounts(&n.m, actor, coord, anchor_site, payer, prev);
        a.extend([
            n.policy.clone(),
            n.link.clone(),
            n.asset.clone(),
            n.resident.clone(),
        ]);
        let inner = wix::ClaimSite {
            p: coord.p(),
            q: coord.q(),
            site,
            slot,
        }
        .to_bytes();
        let mut d = [0u8; 64];
        let len = wix::ResidentAct {
            generation,
            inner: &inner,
        }
        .encode_into(&mut d)
        .unwrap();
        run_tx(&a, &d[..len])
    }

    /// 0xDC WideSettleTicket(k) by the payer for the member's ticket at
    /// `(coord, site)` of `bell`, the beacon of `(bell, region)` staged;
    /// `disp` the displaced holding's rent payer and owner. No funder: a
    /// settle pays the funder nothing, as deployed.
    fn settle(
        &mut self,
        m: &Member,
        k: u8,
        coord: WideCoord,
        site: u8,
        bell: u32,
        disp: Option<(AccountInfo<'static>, &Member)>,
    ) -> Result<(), Refused> {
        let region = WideProvince::read(&self.province_data(coord))
            .map(|p| p.region)
            .unwrap_or(0);
        let beacon = self.stage_seed(bell, region, &BELL_SEED);
        self.settle_with(m, k, coord, site, disp, beacon)
    }

    /// [`Wide::settle`] with the `(seed cache, anchor)` pair given.
    fn settle_with(
        &mut self,
        m: &Member,
        k: u8,
        coord: WideCoord,
        site: u8,
        disp: Option<(AccountInfo<'static>, &Member)>,
        (cache, anchor): (AccountInfo<'static>, AccountInfo<'static>),
    ) -> Result<(), Refused> {
        let mut a = vec![
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.ticket(m),
            self.holding(coord, site),
            self.province(coord),
            self.w.shard(m.faction, m.shard_i),
            cache,
            anchor,
        ];
        if let Some((d_payer, loser)) = disp {
            a.push(unsigned(&d_payer));
            a.push(loser.citizen.clone());
            a.push(self.w.shard(loser.faction, loser.shard_i));
        }
        a.push(self.w.system.clone());
        run_tx(&a, &wix::SettleTicket { k }.to_bytes())
    }

    /// 0xDF WideFinalize of the wide holding at `(coord, site)`.
    fn finalize(&mut self, coord: WideCoord, site: u8) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            self.w.season.clone(),
            self.holding(coord, site),
            with_writable(&self.province(coord), false),
        ];
        run_tx(&a, &wix::Finalize.to_bytes())
    }

    /// 0xDE WideClose(0): the member's ticket record (pending or Settled),
    /// `rent_payer` receiving the record's rent and `funder`, listed when
    /// given, the escrow (CloseCitizen's shape); the member's Citizen
    /// account in its position, present or already closed.
    fn close_ticket(
        &mut self,
        m: &Member,
        rent_payer: AccountInfo<'static>,
        funder: Option<AccountInfo<'static>>,
    ) -> Result<(), Refused> {
        let season = self.w.season.clone();
        self.close_ticket_under(m, rent_payer, funder, season)
    }

    /// [`Wide::close_ticket`] with the Season position given (the Season or
    /// its tombstone).
    fn close_ticket_under(
        &mut self,
        m: &Member,
        rent_payer: AccountInfo<'static>,
        funder: Option<AccountInfo<'static>>,
        season: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let mut a = vec![
            wallet(ANYONE, true, false, 0),
            with_writable(&season, false),
            m.citizen.clone(),
            self.ticket(m),
            unsigned(&rent_payer),
        ];
        if let Some(f) = funder {
            a.push(unsigned(&f));
        }
        run_tx(&a, &wix::Close { what: 0 }.to_bytes())
    }

    /// 0xDE WideClose(1): the wide holding at `(coord, site)` to
    /// `rent_payer`, the DefencePool at position 4.
    fn close_holding(
        &mut self,
        coord: WideCoord,
        site: u8,
        rent_payer: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let season = self.w.season.clone();
        let dpool = self.w.dpool.clone();
        self.close_holding_under(coord, site, rent_payer, season, dpool)
    }

    /// [`Wide::close_holding`] with the Season and the pool positions
    /// given (the tombstone and the Season's authority).
    fn close_holding_under(
        &mut self,
        coord: WideCoord,
        site: u8,
        rent_payer: AccountInfo<'static>,
        season: AccountInfo<'static>,
        dpool: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&season, false),
            self.holding(coord, site),
            unsigned(&rent_payer),
            dpool,
        ];
        run_tx(&a, &wix::Close { what: 1 }.to_bytes())
    }

    /// **Fixture** (module doc): the Closed tombstone of this Season as
    /// CloseSeason leaves it: the Season's first `TOMBSTONE_SIZE` bytes
    /// (magic, id, bump, authority) with the Closed status, at the Season's
    /// address, program-owned. The harness cannot shrink an account in
    /// place, so this is a second account at the same key; the tests that
    /// use it run nothing against the Season afterwards.
    fn tombstone(&mut self) -> AccountInfo<'static> {
        let sd = self.w.season.try_borrow_data().unwrap().to_vec();
        let mut d = sd[..S::TOMBSTONE_SIZE].to_vec();
        d[S::STATUS] = S::STATUS_CLOSED;
        info(leak(self.w.ctx.season, PROGRAM, d, 0, BIG), false, false)
    }

    /// The member's wide ticket record, decoded.
    fn record(&mut self, m: &Member) -> WideTicket {
        let ai = self.ticket(m);
        let d = ai.try_borrow_data().unwrap().to_vec();
        WideTicket::read(&d).unwrap()
    }

    /// The deployed SettleTicket(0) for the member (placeholders for the
    /// site's accounts: the handler must refuse before reading them).
    fn legacy_settle(&mut self, m: &Member) -> Result<(), u32> {
        let a = [
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.w.holding(RIM, 11),
            self.w.province(RIM),
            self.w.shard(m.faction, m.shard_i),
            with_writable(&self.w.frontier, false),
            with_writable(&self.w.frontier, false),
            self.w.system.clone(),
        ];
        code(run_tx(&a, &aix::SettleTicket { k: 0 }.to_bytes()))
    }

    /// The deployed CloseCitizen for the member (no escrow: no funder).
    fn close_citizen(&mut self, m: &Member, rent_payer: AccountInfo<'static>) -> Result<(), u32> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&self.w.season, false),
            m.citizen.clone(),
            unsigned(&rent_payer),
        ];
        code(run_tx(&a, &aix::CloseCitizen {}.to_bytes()))
    }

    /// The deployed CloseHolding over a wide holding (refused: the record
    /// is not a Holding).
    fn legacy_close_holding(
        &mut self,
        coord: WideCoord,
        site: u8,
        rent_payer: AccountInfo<'static>,
    ) -> Result<(), u32> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&self.w.season, false),
            self.holding(coord, site),
            unsigned(&rent_payer),
            self.w.dpool.clone(),
        ];
        code(run_tx(&a, &aix::CloseHolding {}.to_bytes()))
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
        code(run_tx(
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
        ))
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

    /// Ring 129 seeded, the configuration written, (129, 0) opened: the
    /// land every ticket test files on. Returns a free site of it (not the
    /// Free City's) and the first PlaceHome-written Holding's bytes (the
    /// rim-home template, module doc), the member it was placed for being
    /// `a`. Records drained.
    fn land(&mut self) -> (WideCoord, u8, Member, Vec<u8>) {
        self.w.fold();
        assert_eq!(self.request(FIRST_WIDE_RING), Ok(()));
        self.seed_as_consume_would(FIRST_WIDE_RING, &RING129_SEED);
        assert_eq!(self.set_rules(AUTHORITY, RULES), Ok(()));
        let coord = c(129, 0);
        assert_eq!(self.open_province(129, 0), Ok(()));
        let t = generate_province_wide(&RING129_SEED, 129, 0).unwrap();
        let fc = wr::wide_free_city_site(&RING129_SEED, coord, t.site_count);
        let site = (0..t.site_count).find(|s| *s != fc).expect("a free site");
        let (home, nation) = off_wedge_province();
        let a = self.w.member(WALLET_A, nation);
        assert_eq!(self.w.place_home(&a, home, 0), Ok(()));
        let template = self.w.holding_data(home, 0);
        records();
        (coord, site, a, template)
    }

    /// The cohort records of the wide province: `(bell, filed, settled)`.
    fn cohorts(&mut self, coord: WideCoord) -> Vec<(u32, u16, u16)> {
        let pd = self.province_data(coord);
        (0..PV::COHORTS_N)
            .map(|i| {
                let o = PV::cohort(i);
                (
                    rd_u32(&pd, o + CO::BELL),
                    rd_u16(&pd, o + CO::FILED),
                    rd_u16(&pd, o + CO::SETTLED),
                )
            })
            .collect()
    }
}

impl Nft {
    /// TransferResident as the resident program leaves it: the asset's
    /// owner is `to`, the generation goes up by one, no session.
    fn transfer(&mut self, to: &[u8; 32]) {
        self.generation += 1;
        self.asset.try_borrow_mut_data().unwrap()[1..33].copy_from_slice(to);
        self.resident
            .try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&resident_bytes(self.generation));
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

    let mut cold = Wide::rim();
    assert_eq!(cold.request(FIRST_WIDE_RING), Err(E::Capacity as u32));
    assert!(absent(&cold.seed(FIRST_WIDE_RING)));

    let mut w = Wide::rim();
    w.w.fold();
    records();
    let funds_before = w.fund_lamports();
    let frontier_before = w.w.frontier_state();
    let payer_before = w.w.payer.lamports();

    assert_eq!(w.request(R_MAX_HARD as u64), Err(E::BadData as u32));
    assert_eq!(w.w.open_ring(129), Err(E::BadData as u32));
    assert_eq!(
        w.w.open_province(ProvinceCoord::new(129, 0)),
        Err(E::BadData as u32)
    );
    assert_eq!(w.request(130), Err(E::TooEarly as u32));
    assert_eq!(w.open_province(129, 0), Err(E::SeedNotReady as u32));
    w.set_program_version(frontier_abi::v2::presets::PROGRAM_VERSION_S1);
    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::RulesetMismatch as u32));
    assert_eq!(w.open_province(129, 0), Err(E::RulesetMismatch as u32));
    assert_eq!(
        w.set_rules(AUTHORITY, RULES),
        Err(E::RulesetMismatch as u32)
    );
    w.set_program_version(crate::PROGRAM_VERSION);
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
    {
        let rs = w.w.ring_seed(R_MAX_HARD);
        rs.try_borrow_mut_data().unwrap()[RS::STATUS] = RS::STATUS_REQUESTED;
    }
    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::SeedNotReady as u32));
    {
        let rs = w.w.ring_seed(R_MAX_HARD);
        rs.try_borrow_mut_data().unwrap()[RS::STATUS] = RS::STATUS_SEEDED;
    }
    assert!(absent(&w.seed(FIRST_WIDE_RING)));
    assert_eq!(w.fund_lamports(), funds_before);
    assert_eq!(w.w.payer.lamports(), payer_before);
    assert!(records().is_empty(), "a refusal logs nothing");

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
        )
    );
    assert_eq!(rec.terrain_seed(), None);
    assert_eq!(w.w.frontier_state(), frontier_before);
    assert_eq!(
        rd_u16(
            &w.w.ring_seed(R_MAX_HARD).try_borrow_data().unwrap(),
            RS::PROVINCES_CREATED
        ),
        768
    );
    assert!(records().is_empty(), "no PS2 record has an allocated kind");
    assert_ne!(wl::ring_seed_address(&w.w.ctx, 129), w.w.ctx.ring_seed(129));
    assert_ne!(
        wl::province_address(&w.w.ctx, c(129, 0)),
        w.w.ctx.province(129, 0)
    );
    assert_ne!(wr::rules_config_address(&w.w.ctx), w.w.ctx.frontier());
    assert_ne!(
        wt::ticket_address(&w.w.ctx, &WALLET_A),
        w.w.ctx.citizen_by_tag15(&citizen_tag15(&WALLET_A))
    );
    assert_eq!(frontier_abi::addr::host_id(129, 0, 0, 1, 0), None);

    assert_eq!(w.request(FIRST_WIDE_RING), Err(E::AlreadyDone as u32));
    assert_eq!(w.request(130), Err(E::SeedNotReady as u32));
    assert_eq!(w.open_province(129, 0), Err(E::SeedNotReady as u32));

    assert_eq!(w.consume(129, rec.round + 1), Err(E::WrongRound as u32));
    assert_eq!(w.consume(129, rec.round), Err(E::Crypto as u32));
    assert_eq!(w.consume(130, 1), Err(E::BadAccount as u32));
    assert_eq!(w.seed_record(FIRST_WIDE_RING), rec);
    w.seed_as_consume_would(FIRST_WIDE_RING, &RING129_SEED);
    let seeded = w.seed_record(FIRST_WIDE_RING);
    assert_eq!(seeded.status, SeedStatus::Seeded);
    assert_eq!(seeded.terrain_seed(), Some(&RING129_SEED));
    assert_eq!(seeded.round, rec.round);
    assert_eq!(w.consume(129, rec.round), Err(E::AlreadyDone as u32));

    assert_eq!(w.request(130), Err(E::TooEarly as u32));
    let now2 = at_bell(2);
    assert_eq!(w.request(130), Ok(()));
    let r130 = w.seed_record(130);
    assert_eq!((r130.ring, r130.opened_bell, r130.t_open), (130, 2, now2));
    assert!(r130.round > rec.round);
    assert_eq!(w.request(131), Err(E::SeedNotReady as u32));
    w.seed_as_consume_would(130, &RING130_SEED);
    assert_eq!(w.request(131), Err(E::TooEarly as u32));
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
    assert_eq!(w.set_rules(PAYER, RULES), Err(E::Auth as u32));
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
    assert!(absent(&w.config()));
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
        Err(E::AlreadyDone as u32)
    );
    assert_eq!(w.config().try_borrow_data().unwrap().to_vec(), before);
    assert!(records().is_empty());
}

/// The opening through the program: the readiness gate without the
/// configuration, a whole wide province with it (every field compared
/// against the kernels and the candidates), `AlreadyDone`, a short fund
/// refused with nothing created, two wedge-0 neighbours held by different
/// nations.
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

    assert_eq!(w.open_province(128, 0), Err(E::BadData as u32));
    assert_eq!(w.open_province((1 << 62) + 1, 0), Err(E::BadData as u32));
    assert_eq!(w.open_province(130, 0), Err(E::SeedNotReady as u32));
    assert_eq!(
        w.open_province_with_fund(129, 0, 1),
        Err(E::BadAddress as u32)
    );
    for (p, q) in [(129i64, 0i64), (-129, 129), (0, -129), (65, -129)] {
        assert_eq!(w.open_province(p, q), Err(E::NotImplemented as u32));
        assert!(absent(&w.province(c(p, q))));
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
        })
    );
    assert_eq!(w.fund_lamports(), funds_before);
    assert_eq!(w.w.payer.lamports(), payer_before);
    assert_eq!(w.seed_record(FIRST_WIDE_RING), seed_before);
    assert!(records().is_empty());

    assert_eq!(w.set_rules(AUTHORITY, RULES), Ok(()));
    records();

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
    let t = generate_province_wide(&RING129_SEED, 129, 0).unwrap();
    let mut want = vec![0u8; wl::province::SIZE];
    encode_terrain(&t, &mut want).unwrap();
    assert_eq!(&pd[TERRAIN_BLOCK], &want[TERRAIN_BLOCK]);
    assert_eq!(pd[PV::SITE_COUNT], t.site_count);
    assert!(t.site_count > 0);
    let mut legacy = vec![0u8; wl::province::SIZE];
    encode_terrain(
        &generate_province(&RING129_SEED, ProvinceCoord::new(129, 0)),
        &mut legacy,
    )
    .unwrap();
    assert_ne!(
        &pd[TERRAIN_BLOCK], &legacy[TERRAIN_BLOCK],
        "not the legacy noise under another name"
    );
    assert_eq!(rd_u32(&pd, PV::RESOLVED_NEXT), 1);
    assert_eq!(rd_u32(&pd, PV::OPENED_BELL), 1);
    assert_eq!(rd_u32(&pd, PV2::SCORE_NEXT_BELL), 1);
    let k = read_keep(&pd).unwrap().expect("a keep");
    assert_eq!(k.holder, mixed_home_nation(coord, &GENESIS_SEED).unwrap());
    assert_eq!(
        Some(k.tile),
        kkeep::keep_tile(&t, &t.sites, t.site_count, 0)
    );
    assert_eq!(k.troops, w.w.cq.keep_home_guard);
    assert!(!k.heartland_safe);
    assert_eq!((k.since_bell, k.gen, k.progress), (1, 0, 0));
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
    let camp = wr::wide_initial_camp(&RING129_SEED, coord, &t, 0, Some(k.tile)).unwrap();
    assert_eq!(pd[PV::CAMP + CP::TILE], camp.tile);
    assert_eq!(pd[PV::CAMP + CP::STATE], CP::STATE_PRESENT);
    assert_eq!(rd_u32(&pd, PV::CAMP + CP::TROOPS), camp.troops);
    assert_eq!(rd_u32(&pd, PV::CAMP + CP::GEN), 1);
    assert_eq!(rd_u32(&pd, PV::CAMP + CP::NEXT_CHECK_DAY), 1);
    assert_ne!(camp.tile, k.tile);
    assert!(!t.is_site(camp.tile));
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
        seed_before
    );
    assert_eq!(w.w.frontier_state(), frontier_before);
    assert!(records().is_empty(), "no PS2 record has an allocated kind");
    assert_eq!(w.open_province(129, 0), Err(E::AlreadyDone as u32));

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
    assert!(absent(&w.province(other)));
    assert_eq!(w.w.fund(wedge).lamports(), floor + rent - 1);
    assert_eq!(w.w.fund_data(wedge), fund_data_before);
    assert_eq!(w.seed_record(FIRST_WIDE_RING).provinces_created, 1);
    assert!(records().is_empty());
    {
        let f = w.w.fund(wedge);
        **f.try_borrow_mut_lamports().unwrap() = fund_before;
    }

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

/// The wide outpost ticket through the program, over a province the
/// program opened: the deployed FileOutpost prerequisites in order and the
/// filing's writes; every deployed ticket path refusing the marker; the
/// settle (a stale cursor, the seed not staged, fresh with the record kept
/// Settled and nothing refunded, replay); the finality flip refused before
/// its time and applied after it; a slot-3 ticket reusing the record with
/// a wide-rent top-up; a second member's ticket expiring after 24 bells
/// with the wide rent retained in its record and no reclaim while the
/// Season runs; the march gate over the final wide holding.
#[test]
fn wide_land_ticket_is_filed_drawn_settled_and_finalized_as_the_deployed_outpost() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    let payer = w.w.payer.clone();
    let rent_t = crate::init::rent(wt::wide_ticket::SIZE).unwrap();
    let rent_w = crate::init::rent(wh::wide_holding::SIZE).unwrap();

    // The deployed prerequisites, in FileOutpost's order, each refused
    // before any write.
    let pre = (w.province_data(coord), w.w.payer.lamports());
    let file = |w: &mut Wide, actor, coord, site, slot, anchor| {
        code(w.file(&a, actor, coord, site, slot, anchor, payer.clone(), None))
    };
    assert_eq!(
        file(&mut w, WALLET_B, coord, site, 2, 0),
        Err(E::Auth as u32),
        "the deployed player authorization"
    );
    assert_eq!(
        file(&mut w, WALLET_A, c(128, 0), site, 2, 0),
        Err(E::BadData as u32)
    );
    assert_eq!(
        file(&mut w, WALLET_A, c(129, 1), site, 2, 0),
        Err(E::BadAccount as u32),
        "no wide province there"
    );
    assert_eq!(
        file(&mut w, WALLET_A, coord, 12, 2, 0),
        Err(E::BadData as u32)
    );
    assert_eq!(
        file(&mut w, WALLET_A, coord, site, 1, 0),
        Err(E::BadData as u32),
        "slot 1 is the first home's"
    );
    assert_eq!(
        file(&mut w, WALLET_A, coord, site, 3, 0),
        Err(E::TicketState as u32),
        "slot 2 is the lowest free slot"
    );
    // A Hamlet home in the heartland: the deployed prerequisite (Town) and
    // range refuse. The anchor is the Citizen's slot-1 ref, so the rim
    // Holding account is BadAddress until the fixture moves the home.
    assert_eq!(
        file(&mut w, WALLET_A, coord, site, 2, 0),
        Err(E::BadAddress as u32)
    );
    w.fixture_rim_home(&a, &template, 0, 100 * MILLI);
    assert_eq!(
        file(&mut w, WALLET_A, coord, site, 2, 0),
        Err(E::Insufficient as u32),
        "the settler cost from the anchor's stores"
    );
    // A deployed ticket on the Citizen blocks a wide one (TicketState) and
    // is never read as the marker.
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        put(&mut cd, C::TICKET_BELL, &1u32.to_le_bytes());
        cd[C::TICKET_SITES] = 5;
        cd[C2::SLOTS] = 1;
        assert_eq!(wt::pending(&cd), Ok(CitizenTicket::Legacy));
    }
    assert_eq!(
        file(&mut w, WALLET_A, coord, site, 2, 0),
        Err(E::TicketState as u32)
    );
    {
        let mut cd = a.citizen.try_borrow_mut_data().unwrap();
        put(&mut cd, C::TICKET_BELL, &C::NO_TICKET.to_le_bytes());
        cd[C::TICKET_SITES] = 0;
        cd[C2::SLOTS] = 0;
    }
    w.set_stores(0, 1_500 * MILLI);
    assert_eq!(w.province_data(coord), pre.0);
    assert_eq!(w.w.payer.lamports(), pre.1);
    // A record account too small to allocate: the CPI refuses. The deployed
    // `init_with_seed` tops the record up before it allocates, so the
    // executor finds the top-up to undo (the chain reverts it); every byte
    // write of the handler comes after the CPI, and nothing else moved.
    let pre_c = w.w.citizen_data(&a);
    let pre_anchor = w.w.holding_data(RIM, 0);
    w.tickets.remove(&a.key);
    w.ticket_cap(&a.key, 16);
    let e = w
        .file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)
        .err()
        .expect("refused");
    assert_eq!(e.code, u32::MAX, "a refused allocation is no program code");
    assert!(e.wrote, "the top-up preceded the refused allocation");
    w.tickets.remove(&a.key);
    assert!(absent(&w.ticket(&a)));
    assert_eq!(w.w.citizen_data(&a), pre_c);
    assert_eq!(w.w.holding_data(RIM, 0), pre_anchor);
    assert_eq!(w.province_data(coord), pre.0);
    assert_eq!(w.w.payer.lamports(), pre.1, "restored");
    assert!(records().is_empty(), "a refusal logs nothing");

    // The filing.
    let anchor_before = w.w.holding_data(RIM, 0);
    let payer_before = w.w.payer.lamports();
    assert_eq!(file(&mut w, WALLET_A, coord, site, 2, 0), Ok(()));
    let rec_ai = w.ticket(&a);
    assert_eq!(*rec_ai.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(rec_ai.lamports(), rent_t + rent_w, "the isolated escrow");
    assert_eq!(w.w.payer.lamports(), payer_before - rent_t - rent_w);
    let rec = WideTicket::read(&rec_ai.try_borrow_data().unwrap()).unwrap();
    assert_eq!(
        (
            rec.citizen,
            rec.coord,
            rec.site,
            rec.slot,
            rec.bell,
            rec.next
        ),
        (a.key, coord, site, 2, 1, 0)
    );
    assert_eq!(rec.funder, PAYER);
    assert_eq!(rec.world, w.world_id());
    let cd = w.w.citizen_data(&a);
    assert_eq!(
        wt::pending(&cd),
        Ok(CitizenTicket::Wide { bell: 1, slot: 2 })
    );
    assert_eq!(rd_u32(&cd, C::TICKET_BELL), 1);
    assert_eq!(cd[C2::SLOTS] & C2::SLOTS_TICKET_MASK, 2);
    assert_eq!(
        Ro(&cd).u64(C::TICKET_ESCROW).unwrap(),
        0,
        "the shared escrow is untouched"
    );
    assert_eq!(cd[C::HOLDINGS_N], 1);
    assert_eq!(
        C2::lowest_free_slot(cd[C2::SLOTS], C2::EMPTY_GEN, C2::EMPTY_GEN),
        Some(3)
    );
    let anchor_after = w.w.holding_data(RIM, 0);
    assert_ne!(
        anchor_after, anchor_before,
        "the anchor paid the settler cost"
    );
    let cost = crate::proc::citizen::settler_cost(1).unwrap();
    for r in 0..RESOURCES {
        let before = rd_i64(&anchor_before, H::store(r) + AC::VALUE);
        let after = rd_i64(&anchor_after, H::store(r) + AC::VALUE);
        assert!(after <= before - cost[r] + 1_000, "store {r}");
    }
    assert_eq!(
        w.cohorts(coord)[0],
        (1, 1, 0),
        "the cohort of bell 1 took the ticket"
    );
    let recs = records();
    assert_eq!(recs.len(), 1);
    assert_eq!(
        decode_record(&recs[0]).unwrap().kind,
        AnyKind::V1(Kind::HARVEST),
        "the anchor's HARVEST, as FileOutpost logs"
    );

    // The deployed paths refuse the marker explicitly, before parsing.
    assert_eq!(w.legacy_settle(&a), Err(E::TicketState as u32));
    assert_eq!(
        file(&mut w, WALLET_A, coord, site, 3, 0),
        Err(E::TicketState as u32)
    );
    assert_eq!(w.w.place_home(&a, RIM, 1), Err(E::AlreadyDone as u32));
    assert_eq!(
        crate::proc::wide::refuse_wide_ticket(&w.w.citizen_data(&a)),
        Err(E::TicketState.into()),
        "the guard DeclareSiege, SettleTicket and CloseCitizen call"
    );
    assert!(records().is_empty());

    // The settle: the cursor, the seed, then fresh. (The settle names no
    // funder: it pays the funder nothing, as deployed.)
    let settle = |w: &mut Wide, k| code(w.settle(&a, k, coord, site, 1, None));
    assert_eq!(settle(&mut w, 1), Err(E::TicketState as u32));
    {
        // the beacon not yet posted: no anchor, then an anchor without its
        // seed cache (an absent account at the cache position)
        let region = WideProvince::read(&w.province_data(coord)).unwrap().region;
        let (cache, anchor) = w.stage_seed(1, region, &BELL_SEED);
        let none = w.w.system.clone();
        assert_eq!(
            code(w.settle_with(&a, 0, coord, site, None, (none.clone(), none.clone()))),
            Err(E::BadAddress as u32),
            "THE anchor must be named"
        );
        assert_eq!(
            code(w.settle_with(&a, 0, coord, site, None, (none, anchor.clone()))),
            Err(E::SeedNotReady as u32)
        );
        let _ = cache;
    }
    let citizen_before = w.w.citizen_data(&a);
    let payer_before = w.w.payer.lamports();
    let shard_before = w.w.shard_counts(&a);
    assert_eq!(settle(&mut w, 0), Ok(()));
    // The holding: provisional, from the record's rent, the ticket's bell
    // and score, the season's outpost shield, the funder as rent payer.
    let hai = w.holding(coord, site);
    assert_eq!(*hai.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(hai.lamports(), rent_w);
    let hd = w.holding_data(coord, site);
    let wide = WideHolding::read(&hd).unwrap();
    assert_eq!(
        (wide.coord, wide.site, wide.gen, wide.slot),
        (coord, site, 1, 2)
    );
    assert_eq!(wide.owner_citizen, a.key);
    assert_eq!(wide.host_identity, HOST_IDENTITY_UNALLOCATED);
    assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
    assert_eq!(hd[H::ORDER], 2);
    assert_eq!(hd[H::TIER], Tier::Hamlet as u8);
    assert_eq!(rd_u32(&hd, H::TICKET_BELL), 1);
    assert_eq!(
        Ro(&hd).u64(H::TICKET_SCORE).unwrap(),
        wt::wide_ticket_score(&BELL_SEED, coord, site, citizen_tag(&a.key))
    );
    let final_ts = rd_i64(&hd, H::FINAL_TS);
    assert_eq!(final_ts, w.final_ts_of(1));
    assert_eq!(&hd[H::RENT_PAYER..H::RENT_PAYER + 32], &PAYER);
    assert_eq!(
        rd_i64(&hd, H::SHIELD_UNTIL),
        GENESIS + 600 + w.w.cq.outpost_shield_secs as i64,
        "the outpost shield"
    );
    assert_eq!(Ro(&hd).u64(H::POOL_OWED).unwrap(), 0);
    // The record stays, Settled, its escrow consumed by the win: the
    // record's own rent is retained for the next filing (the deployed
    // escrow's retention), and nothing goes back to the funder now.
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.bell, rec.site),
        (TicketStatus::Settled, 0, PAYER, 1, site)
    );
    assert_eq!(w.ticket(&a).lamports(), rent_t);
    assert_eq!(w.w.payer.lamports(), payer_before, "nothing refunded");
    // The Citizen: no ticket, the slot bound, one inventory of two.
    let cd = w.w.citizen_data(&a);
    assert_eq!(wt::pending(&cd), Ok(CitizenTicket::None));
    assert_eq!(cd[C2::SLOTS], 0);
    assert_eq!(wh::binding_of(&cd, 2), Ok(wh::SlotBinding::Wide));
    assert_eq!(cd[C::HOLDINGS_N], 2);
    assert_eq!(
        cd[C::FLAGS],
        citizen_before[C::FLAGS],
        "the first-home flags"
    );
    // The province's mirror and cohort; the JoinShard's outposts.
    let pd = w.province_data(coord);
    let so = PV::site(site as usize);
    assert_eq!(pd[so + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(pd[so + SM::FACTION], a.faction);
    assert_eq!(pd[so + SM::ORDER], 2);
    assert_eq!(pd[so + SM::GEN], 1);
    assert_eq!(pd[PV::N_SITES_USED], 1);
    assert_eq!(w.cohorts(coord)[0], (1, 1, 1), "settled");
    let shard_after = w.w.shard(a.faction, a.shard_i);
    let jd = shard_after.try_borrow_data().unwrap().to_vec();
    assert_eq!(rd_u32(&jd, JS2::EXTRA_HOLDINGS), 1);
    assert_eq!(rd_u32(&jd, JS2::OUTPOSTS), 1);
    assert_eq!(
        w.w.shard_counts(&a),
        shard_before,
        "the first-home counters untouched"
    );
    assert!(records().is_empty(), "no PS2 record of the wide settlement");
    // Replay: the ticket ended (no marker; the Settled record is no ticket
    // to the wide settle, and the deployed paths see no ticket at all).
    assert_eq!(settle(&mut w, 0), Err(E::NoTicket as u32));
    assert_eq!(w.legacy_settle(&a), Err(E::NoTicket as u32));
    assert_eq!(
        crate::proc::wide::refuse_wide_ticket(&w.w.citizen_data(&a)),
        Ok(()),
        "a Settled record holds no deployed path"
    );

    // Finality: timestamp and cohort closure. Before `final_ts` it is
    // refused; the slot-3 filing sees a provisional slot 2 (OutpostRule).
    assert_eq!(code(w.finalize(coord, site)), Err(E::TooEarly as u32));
    let site3 = (0..pd[PV::SITE_COUNT])
        .find(|s| *s != site && pd[PV::site(*s as usize) + SM::STATE] == SM::STATE_FREE)
        .expect("another free site");
    assert_eq!(
        code(w.file(
            &a,
            WALLET_A,
            coord,
            site3,
            3,
            0,
            payer.clone(),
            Some((coord, site))
        )),
        Err(CE::OutpostRule.code()),
        "slot 2 is not final yet"
    );
    assert_eq!(w.holding_data(coord, site)[H::STATE], H::STATE_PROVISIONAL);
    assert!(
        final_ts < GENESIS + 600 * 3,
        "the fixture anchor lands inside bell 1"
    );
    at_bell(3);
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    assert_eq!(w.holding_data(coord, site)[H::STATE], H::STATE_FINAL);
    assert_eq!(w.w.citizen_data(&a)[C::FLAGS], citizen_before[C::FLAGS]);
    assert_eq!(code(w.finalize(coord, site)), Err(E::AlreadyDone as u32));
    assert!(records().is_empty());

    // A second ticket into slot 3 (slot 2 final; the third holding's settler
    // cost is 1.5× the base, so the anchor is restocked), drawn at bell 3
    // and settled fresh: three holdings, one inventory. The filing reuses
    // the Settled record: its escrow is empty, so the payer tops up the
    // wide rent (and only that: the record's own rent was paid once) and
    // is the funder.
    w.set_stores(0, 3_000 * MILLI);
    let payer_before = w.w.payer.lamports();
    assert_eq!(
        code(w.file(
            &a,
            WALLET_A,
            coord,
            site3,
            3,
            0,
            payer.clone(),
            Some((coord, site))
        )),
        Ok(())
    );
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.bell, rec.site, rec.slot),
        (TicketStatus::Open, rent_w, PAYER, 3, site3, 3)
    );
    assert_eq!(w.ticket(&a).lamports(), rent_t + rent_w);
    assert_eq!(w.w.payer.lamports(), payer_before - rent_w, "the top-up");
    assert!(w.cohorts(coord).contains(&(3, 1, 0)));
    records();
    assert_eq!(
        code(w.settle(&a, 0, coord, site3, 3, None)),
        Ok(()),
        "not expired: the draw of bell 3 settles"
    );
    let cd = w.w.citizen_data(&a);
    assert_eq!(cd[C::HOLDINGS_N], 3);
    assert_eq!(wh::binding_of(&cd, 3), Ok(wh::SlotBinding::Wide));
    assert_eq!(w.w.payer.lamports(), payer_before - rent_w);
    assert_eq!(w.record(&a).escrow, 0);
    assert!(records().is_empty());

    // Expiry: member B (another nation) files at bell 3 on a third site and
    // nobody settles for 24 bells; the settle then ends the ticket and the
    // record **retains** the wide rent, as the deployed escrow stays in
    // the Citizen after an expiry: nothing goes back while the Season runs.
    let (_, nation) = off_wedge_province();
    let b = w.w.member(WALLET_B, (nation + 1) % 6);
    w.fixture_rim_home(&b, &template, 1, 1_500 * MILLI);
    let pd = w.province_data(coord);
    let site_b = (0..pd[PV::SITE_COUNT])
        .find(|s| pd[PV::site(*s as usize) + SM::STATE] == SM::STATE_FREE)
        .expect("a free site");
    let payer2 = w.wallet_of(PAYER2);
    let payer2_before = payer2.lamports();
    assert_eq!(
        code(w.file(&b, WALLET_B, coord, site_b, 2, 1, payer2.clone(), None)),
        Ok(())
    );
    assert_eq!(payer2.lamports(), payer2_before - rent_t - rent_w);
    records();
    at_bell(3 + PV::COHORT_BELLS);
    let province_before = w.province_data(coord);
    assert_eq!(code(w.settle(&b, 0, coord, site_b, 3, None)), Ok(()));
    let rec = w.record(&b);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder),
        (TicketStatus::Settled, rent_w, PAYER2),
        "expired: the wide rent retained for its funder"
    );
    assert_eq!(w.ticket(&b).lamports(), rent_t + rent_w);
    assert!(absent(&w.holding(coord, site_b)), "nothing founded");
    assert_eq!(
        payer2.lamports(),
        payer2_before - rent_t - rent_w,
        "nothing back while the Season runs"
    );
    assert_eq!(
        code(w.close_ticket(&b, payer2.clone(), Some(payer2.clone()))),
        Err(E::WrongStatus as u32),
        "no reclaim before season end, as deployed"
    );
    let cd = w.w.citizen_data(&b);
    assert_eq!(wt::pending(&cd), Ok(CitizenTicket::None));
    assert_eq!(cd[C::HOLDINGS_N], 1);
    let pd = w.province_data(coord);
    assert_eq!(pd[PV::site(site_b as usize) + SM::STATE], SM::STATE_FREE);
    assert_eq!(pd[PV::N_SITES_USED], province_before[PV::N_SITES_USED]);
    assert!(
        w.cohorts(coord).contains(&(3, 2, 2)),
        "the cohort of bell 3 settled"
    );
    assert!(records().is_empty());
    // Slot 3 finalizes independently, without another paid claim.
    assert_eq!(code(w.finalize(coord, site3)), Ok(()));
    assert_eq!(w.holding_data(coord, site3)[H::STATE], H::STATE_FINAL);
    assert_eq!(w.w.citizen_data(&a)[C::HOLDINGS_N], 3);

    // The march gate over the final wide holding: the deployed checks, then
    // the identity gate, nothing written.
    at_bell(3 + PV::COHORT_BELLS);
    let key = ProvinceKey::new(w.world_id(), coord);
    let host = WideHostRef::new(key, site, 1, 0).unwrap();
    let holding_before = w.holding_data(coord, site);
    assert_eq!(w.depart(&b, host, 40), Err(E::NotOwner as u32));
    assert_eq!(
        w.depart(&a, host, 40),
        Err(E::NotResident as u32),
        "the province was never resolved past its opening"
    );
    {
        let province = w.province(coord);
        let mut pd = province.try_borrow_mut_data().unwrap();
        put(
            &mut pd,
            PV::RESOLVED_NEXT,
            &(3 + PV::COHORT_BELLS).to_le_bytes(),
        );
    }
    assert_eq!(w.depart(&a, host, 1), Err(E::ArrivalBell as u32));
    assert_eq!(w.depart(&a, host, 40), Err(E::NotImplemented as u32));
    {
        let province = w.province(coord);
        let mut pd = province.try_borrow_mut_data().unwrap();
        put(&mut pd, PV::RESOLVED_NEXT, &1u32.to_le_bytes());
    }
    assert_eq!(w.holding_data(coord, site), holding_before);
    assert!(records().is_empty());
}

/// Two tickets of one cohort on one site: the lower score settles fresh,
/// the higher displaces it (the loser unbound, its funder refunded the
/// wide rent, the holding rewritten at generation 2 for the winner); a
/// third, lower, is taken. Then the refusals that must precede every
/// write: a full cohort, a reservation on the ticket's slot, a marker
/// disagreeing with its record, a counter at its maximum, an allocation
/// the holding account cannot take; and the season-end close of a wide
/// holding where the deployed CloseHolding refuses the record.
#[test]
fn wide_land_ticket_lottery_displaces_the_lower_score_and_refuses_before_writing() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    // Three nations, so the deployed share rule never meets a nation
    // already holding the province.
    let (_, nation) = off_wedge_province();
    let b = w.w.member(WALLET_B, (nation + 1) % 6);
    let s = w.w.member(WALLET_S, (nation + 2) % 6);
    w.fixture_rim_home(&a, &template, 0, 1_500 * MILLI);
    w.fixture_rim_home(&b, &template, 1, 1_500 * MILLI);
    w.fixture_rim_home(&s, &template, 2, 1_500 * MILLI);
    let payer = w.w.payer.clone();
    let payer2 = w.wallet_of(PAYER2);
    let rent_t = crate::init::rent(wt::wide_ticket::SIZE).unwrap();
    let rent_w = crate::init::rent(wh::wide_holding::SIZE).unwrap();

    // Both file in bell 1 for the same site: the cohort holds two.
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)),
        Ok(())
    );
    assert_eq!(
        code(w.file(&b, WALLET_B, coord, site, 2, 1, payer2.clone(), None)),
        Ok(())
    );
    assert_eq!(w.cohorts(coord)[0], (1, 2, 0));
    records();
    let score = |m: &Member| wt::wide_ticket_score(&BELL_SEED, coord, site, citizen_tag(&m.key));
    let (lo, hi, lo_payer, hi_payer) = if crate::proc::citizen::displaces(
        score(&b),
        citizen_tag(&b.key),
        score(&a),
        citizen_tag(&a.key),
    ) {
        (&a, &b, payer.clone(), payer2.clone())
    } else {
        (&b, &a, payer2.clone(), payer.clone())
    };
    let lo_shard0 =
        w.w.shard(lo.faction, lo.shard_i)
            .try_borrow_data()
            .unwrap()
            .to_vec();
    // The lower settles fresh.
    assert_eq!(code(w.settle(lo, 0, coord, site, 1, None)), Ok(()));
    let hd = w.holding_data(coord, site);
    assert_eq!(WideHolding::read(&hd).unwrap().owner_citizen, lo.key);
    assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
    assert_eq!(w.cohorts(coord)[0], (1, 2, 1));
    assert_eq!(w.record(lo).escrow, 0, "the win consumed the wide rent");
    // The higher without the displaced trio: TooManyAccounts, nothing
    // written; with it: displaced.
    assert_eq!(
        code(w.settle(hi, 0, coord, site, 1, None)),
        Err(E::TooManyAccounts as u32)
    );
    let lo_payer_before = lo_payer.lamports();
    let hi_payer_before = hi_payer.lamports();
    assert_eq!(
        code(w.settle(hi, 0, coord, site, 1, Some((lo_payer.clone(), lo)))),
        Ok(())
    );
    let hd = w.holding_data(coord, site);
    let wide = WideHolding::read(&hd).unwrap();
    assert_eq!(wide.owner_citizen, hi.key);
    assert_eq!(wide.gen, 2, "the next generation");
    assert_eq!(wide.slot, 2);
    assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
    assert_eq!(Ro(&hd).u64(H::TICKET_SCORE).unwrap(), score(hi));
    assert_eq!(
        &hd[H::RENT_PAYER..H::RENT_PAYER + 32],
        hi_payer.key.as_ref()
    );
    assert_eq!(
        Ro(&hd).u64(H::POOL_OWED).unwrap(),
        0,
        "the refund was paid, not diverted"
    );
    assert_eq!(w.holding(coord, site).lamports(), rent_w);
    assert_eq!(
        lo_payer.lamports(),
        lo_payer_before + rent_w,
        "the loser's funder refunded from the winner's escrow"
    );
    assert_eq!(
        hi_payer.lamports(),
        hi_payer_before,
        "the winner's funder gets nothing back now"
    );
    let hrec = w.record(hi);
    assert_eq!((hrec.status, hrec.escrow), (TicketStatus::Settled, 0));
    assert_eq!(
        w.ticket(hi).lamports(),
        rent_t,
        "the winner's record retained"
    );
    assert_eq!(
        w.record(lo).escrow,
        0,
        "the loser's refund went to its holding's rent payer, not its record"
    );
    let lcd = w.w.citizen_data(lo);
    assert_eq!(
        wh::binding_of(&lcd, 2),
        Ok(wh::SlotBinding::Empty),
        "the loser unbound"
    );
    assert_eq!(lcd[C::HOLDINGS_N], 1);
    assert_eq!(wt::pending(&lcd), Ok(CitizenTicket::None));
    let hcd = w.w.citizen_data(hi);
    assert_eq!(wh::binding_of(&hcd, 2), Ok(wh::SlotBinding::Wide));
    assert_eq!(hcd[C::HOLDINGS_N], 2);
    let pd = w.province_data(coord);
    assert_eq!(pd[PV::site(site as usize) + SM::GEN], 2);
    assert_eq!(
        pd[PV::N_SITES_USED],
        1,
        "the site was not free: not counted twice"
    );
    assert_eq!(w.cohorts(coord)[0], (1, 2, 2));
    {
        let jd =
            w.w.shard(lo.faction, lo.shard_i)
                .try_borrow_data()
                .unwrap()
                .to_vec();
        assert_eq!(jd, lo_shard0, "the loser's shard back where it started");
        let jd =
            w.w.shard(hi.faction, hi.shard_i)
                .try_borrow_data()
                .unwrap()
                .to_vec();
        assert_eq!(rd_u32(&jd, JS2::OUTPOSTS), 1);
        assert_eq!(rd_u32(&jd, JS2::EXTRA_HOLDINGS), 1);
    }
    assert!(records().is_empty(), "paid directly: no DIVERT");

    // A third ticket of the same bell on the taken site: the settle decides
    // by the deployed rule (the holding is provisional at generation 2 of
    // the same bell): a lower score is taken and its record retains the
    // wide rent (the deployed escrow after a taken site); a higher one
    // displaces again with the trio.
    let s_before = payer.lamports();
    assert_eq!(
        code(w.file(&s, WALLET_S, coord, site, 2, 2, payer.clone(), None)),
        Ok(()),
        "a filing names a taken site: the settle decides"
    );
    records();
    let displaced_again = crate::proc::citizen::displaces(
        score(&s),
        citizen_tag(&s.key),
        score(hi),
        citizen_tag(&hi.key),
    );
    if displaced_again {
        assert_eq!(
            code(w.settle(&s, 0, coord, site, 1, None)),
            Err(E::TooManyAccounts as u32),
            "it displaces: the trio is needed"
        );
        assert_eq!(
            code(w.settle(&s, 0, coord, site, 1, Some((hi_payer.clone(), hi)))),
            Ok(())
        );
        let wd = WideHolding::read(&w.holding_data(coord, site)).unwrap();
        assert_eq!((wd.owner_citizen, wd.gen), (s.key, 3));
        assert_eq!(
            wh::binding_of(&w.w.citizen_data(hi), 2),
            Ok(wh::SlotBinding::Empty)
        );
        assert_eq!(w.record(&s).escrow, 0);
        assert_eq!(payer.lamports(), s_before - rent_t - rent_w);
    } else {
        assert_eq!(code(w.settle(&s, 0, coord, site, 1, None)), Ok(()));
        assert_eq!(
            payer.lamports(),
            s_before - rent_t - rent_w,
            "taken: the wide rent retained, nothing back"
        );
        assert_eq!(w.record(&s).escrow, rent_w);
        assert_eq!(w.ticket(&s).lamports(), rent_t + rent_w);
        assert_eq!(w.w.citizen_data(&s)[C::HOLDINGS_N], 1);
        assert_eq!(
            WideHolding::read(&w.holding_data(coord, site))
                .unwrap()
                .owner_citizen,
            hi.key
        );
    }
    assert_eq!(w.record(&s).status, TicketStatus::Settled);
    assert_eq!(wt::pending(&w.w.citizen_data(&s)), Ok(CitizenTicket::None));
    assert_eq!(w.cohorts(coord)[0], (1, 3, 3));

    // The refusals that must precede every write, each with its state
    // compared before and after (the executor's restore finds nothing to
    // undo: `code` asserts it). The loser of the first draw files again
    // over its Settled record (its escrow empty: the payer tops up the wide
    // rent and becomes the funder).
    at_bell(30);
    let pd0 = w.province_data(coord);
    let free = (0..pd0[PV::SITE_COUNT])
        .find(|x| pd0[PV::site(*x as usize) + SM::STATE] == SM::STATE_FREE)
        .expect("a free site");
    // a full cohort table: eight open cohorts of recent bells
    {
        let pv = w.province(coord);
        let mut pd = pv.try_borrow_mut_data().unwrap();
        for i in 0..PV::COHORTS_N {
            let o = PV::cohort(i);
            put(&mut pd, o + CO::BELL, &(10 + i as u32).to_le_bytes());
            put(&mut pd, o + CO::FILED, &1u16.to_le_bytes());
            put(&mut pd, o + CO::SETTLED, &0u16.to_le_bytes());
        }
    }
    let m = lo;
    let anchor_site = if lo.key == a.key { 0 } else { 1 };
    w.set_stores(anchor_site, 3_000 * MILLI);
    let snapshot = (
        w.w.citizen_data(m),
        w.w.holding_data(RIM, anchor_site),
        payer.lamports(),
    );
    assert_eq!(
        code(w.file(
            m,
            m.wallet,
            coord,
            free,
            2,
            anchor_site,
            payer.clone(),
            None
        )),
        Err(E::CohortFull as u32)
    );
    assert_eq!(
        (
            w.w.citizen_data(m),
            w.w.holding_data(RIM, anchor_site),
            payer.lamports()
        ),
        snapshot
    );
    assert_eq!(
        w.province_data(coord)[PV::site(free as usize) + SM::STATE],
        SM::STATE_FREE
    );
    {
        let pv = w.province(coord);
        let mut pd = pv.try_borrow_mut_data().unwrap();
        for i in 0..PV::COHORTS_N {
            let o = PV::cohort(i);
            pd[o..o + CO::SIZE].copy_from_slice(&pd0[o..o + CO::SIZE]);
        }
    }
    // a filed ticket whose Citizen then shows a reservation on the ticket's
    // slot, or a marker disagreeing with its record: refused before any
    // write at the settle
    assert_eq!(
        code(w.file(
            m,
            m.wallet,
            coord,
            free,
            2,
            anchor_site,
            payer.clone(),
            None
        )),
        Ok(())
    );
    records();
    let pending = (
        w.w.citizen_data(m),
        w.ticket(m).try_borrow_data().unwrap().to_vec(),
        w.ticket(m).lamports(),
    );
    {
        let mut cd = m.citizen.try_borrow_mut_data().unwrap();
        cd[C2::SLOTS] |= C2::SLOTS_RESERVED_2;
    }
    let frec = w.record(m);
    assert_eq!(
        (frec.status, frec.escrow, frec.funder),
        (TicketStatus::Open, rent_w, PAYER)
    );
    assert_eq!(
        code(w.settle(m, 0, coord, free, 30, None)),
        Err(E::BadAccount as u32),
        "a reservation on the ticket's slot is no state the program writes"
    );
    {
        let mut cd = m.citizen.try_borrow_mut_data().unwrap();
        cd[C2::SLOTS] &= !C2::SLOTS_RESERVED_2;
        put(&mut cd, C::TICKET_BELL, &31u32.to_le_bytes());
    }
    assert_eq!(
        code(w.settle(m, 0, coord, free, 30, None)),
        Err(E::BadAccount as u32),
        "the marker disagrees with the record"
    );
    {
        // a Settled record under a wide marker: no state the program
        // writes, refused by the settle and by a new filing alike
        let ai = w.ticket(m);
        let mut td = ai.try_borrow_mut_data().unwrap();
        td[wt::wide_ticket::STATUS] = wt::wide_ticket::STATUS_SETTLED;
    }
    assert_eq!(
        code(w.settle(m, 0, coord, free, 30, None)),
        Err(E::BadAccount as u32)
    );
    assert_eq!(
        code(w.file(
            m,
            m.wallet,
            coord,
            free,
            2,
            anchor_site,
            payer.clone(),
            None
        )),
        Err(E::BadAccount as u32)
    );
    {
        let ai = w.ticket(m);
        let mut td = ai.try_borrow_mut_data().unwrap();
        td[wt::wide_ticket::STATUS] = wt::wide_ticket::STATUS_OPEN;
        let mut cd = m.citizen.try_borrow_mut_data().unwrap();
        put(&mut cd, C::TICKET_BELL, &30u32.to_le_bytes());
    }
    // a JoinShard counter at its maximum: Overflow before any write
    let shard = w.w.shard(m.faction, m.shard_i);
    let saved = shard.try_borrow_data().unwrap().to_vec();
    put(
        &mut shard.try_borrow_mut_data().unwrap(),
        JS2::OUTPOSTS,
        &u32::MAX.to_le_bytes(),
    );
    assert_eq!(
        code(w.settle(m, 0, coord, free, 30, None)),
        Err(E::Overflow as u32)
    );
    shard.try_borrow_mut_data().unwrap().copy_from_slice(&saved);
    // the holding account cannot take the allocation: the CPI refuses
    // before any byte write (the record keeps its lamports)
    w.holdings.remove(&(coord.p(), coord.q(), free));
    w.holding_cap(coord, free, 16);
    let e = w
        .settle(m, 0, coord, free, 30, None)
        .err()
        .expect("refused");
    assert_eq!((e.code, e.wrote), (u32::MAX, false));
    w.holdings.remove(&(coord.p(), coord.q(), free));
    assert_eq!(
        (
            w.w.citizen_data(m),
            w.ticket(m).try_borrow_data().unwrap().to_vec(),
            w.ticket(m).lamports()
        ),
        pending,
        "the pending ticket as filed"
    );
    assert!(records().is_empty());
    // and then it settles
    assert_eq!(code(w.settle(m, 0, coord, free, 30, None)), Ok(()));
    assert_eq!(
        (w.record(m).status, w.record(m).escrow),
        (TicketStatus::Settled, 0)
    );

    // Season end (Ended + 72 h): the wide holding closes to its rent payer
    // through WideClose(1); the deployed CloseHolding refuses the record.
    w.set_status(S::STATUS_ENDED);
    let end = GENESIS + 200_000i64 * 600 + crate::proc::map::END_GRACE_SECS;
    crate::prologue::set_test_clock(end - 1, 5_000);
    let rp: [u8; 32] = w.holding_data(coord, site)[H::RENT_PAYER..H::RENT_PAYER + 32]
        .try_into()
        .unwrap();
    let (rp_acc, wrong) = if rp == PAYER {
        (payer.clone(), payer2.clone())
    } else {
        (payer2.clone(), payer.clone())
    };
    assert_eq!(
        code(w.close_holding(coord, site, rp_acc.clone())),
        Err(E::TooEarly as u32)
    );
    crate::prologue::set_test_clock(end, 5_001);
    assert_eq!(
        w.legacy_close_holding(coord, site, rp_acc.clone()),
        Err(E::BadAccount as u32),
        "a 1,344-byte record is no deployed Holding"
    );
    assert_eq!(
        code(w.close_holding(coord, site, wrong)),
        Err(E::BadAddress as u32)
    );
    // Literal pre-state for an accrued pool obligation, not new revenue.
    let pool_before = w.w.dpool.lamports();
    let owed = 1234u64;
    {
        let holding = w.holding(coord, site);
        **holding.try_borrow_mut_lamports().unwrap() += owed;
        put(
            &mut holding.try_borrow_mut_data().unwrap(),
            H::POOL_OWED,
            &owed.to_le_bytes(),
        );
    }
    let before = rp_acc.lamports();
    assert_eq!(code(w.close_holding(coord, site, rp_acc.clone())), Ok(()));
    assert_eq!(w.w.dpool.lamports(), pool_before + owed);
    assert!(absent(&w.holding(coord, site)));
    assert_eq!(
        rp_acc.lamports(),
        before + rent_w,
        "the holding's rent to its payer"
    );
    assert!(records().is_empty());

    // The Closed tombstone (CloseSeason has run): the three Settled records
    // still close in CloseCitizen's shape: the funder position exactly when
    // there is an escrow (`TooManyAccounts` otherwise), the record's rent
    // to its immutable rent payer (the creator), the escrow to the last
    // payer that topped it up; a replay `NoTicket`; the Citizens are
    // present (CloseCitizen may run in either order around a Settled
    // record). The loser of the first draw refiled with the payer at bell
    // 30, so when it is member b its funder is the payer while its rent
    // payer stays the second payer: the two recipients differ.
    let tomb = w.tombstone();
    let acc = |k: [u8; 32]| {
        if k == PAYER {
            payer.clone()
        } else {
            assert_eq!(k, PAYER2);
            payer2.clone()
        }
    };
    for m in [&a, &b, &s] {
        let rec = w.record(m);
        assert_eq!(rec.status, TicketStatus::Settled);
        let (rp, f) = (acc(rec.rent_payer), acc(rec.funder));
        let held = w.ticket(m).lamports();
        assert_eq!(held, rent_t + rec.escrow, "the record covers its escrow");
        let wrong_shape = if rec.escrow > 0 {
            None
        } else {
            Some(f.clone())
        };
        assert_eq!(
            code(w.close_ticket_under(m, rp.clone(), wrong_shape, tomb.clone())),
            Err(E::TooManyAccounts as u32),
            "the funder exactly when there is an escrow"
        );
        let funder = (rec.escrow > 0).then(|| f.clone());
        let (rp_before, f_before) = (rp.lamports(), f.lamports());
        assert_eq!(
            code(w.close_ticket_under(m, rp.clone(), funder.clone(), tomb.clone())),
            Ok(())
        );
        assert!(absent(&w.ticket(m)));
        if rp.key == f.key {
            assert_eq!(rp.lamports(), rp_before + held, "one recipient: whole");
        } else {
            assert_eq!(rp.lamports(), rp_before + rent_t, "the record's rent");
            assert_eq!(f.lamports(), f_before + rec.escrow, "the escrow");
        }
        assert_eq!(
            code(w.close_ticket_under(m, rp.clone(), funder, tomb.clone())),
            Err(E::NoTicket as u32)
        );
        assert_eq!(
            wt::pending(&w.w.citizen_data(m)),
            Ok(CitizenTicket::None),
            "nothing on the Citizen changed"
        );
    }
    assert!(records().is_empty());
}

/// An NFT resident's Citizen through the band's own act: the real resident
/// check (the policy, the link, the asset's current owner, the signed
/// holder generation); a stale generation, a previous owner, an unsigned
/// owner and the wallet form refused; a transfer handing the pending ticket
/// to the new holder's generation, the Citizen's Settled record then reused
/// by the new holder's act (the payer topping up the wide rent); then
/// season end (Aborted): CloseCitizen refusing while the wide ticket is
/// pending, WideClose(0) returning the record (one payer: rent payer and
/// funder) and clearing the marker (the reservation bits kept), swapped or
/// missing recipients refused, CloseCitizen closing after it.
#[test]
fn wide_land_nft_resident_acts_at_its_generation_and_season_end_closes_the_ticket_first() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, _a, template) = w.land();
    let (_, nation) = off_wedge_province();
    let mut n = w.nft(nation, OWNER_A);
    w.fixture_rim_home(&n.m, &template, 3, 1_500 * MILLI);
    let payer = w.w.payer.clone();
    let rent_t = crate::init::rent(wt::wide_ticket::SIZE).unwrap();
    let rent_w = crate::init::rent(wh::wide_holding::SIZE).unwrap();
    let before = (w.w.citizen_data(&n.m), payer.lamports());

    // The wallet form refuses the NFT Citizen by address.
    assert_eq!(
        code(w.file(&n.m, OWNER_A, coord, site, 2, 3, payer.clone(), None)),
        Err(E::BadAddress as u32)
    );
    // The act: the deployed resident refusals.
    assert_eq!(
        code(w.act_file(&n, OWNER_A, 1, coord, site, 2, 3, None)),
        Err(CE::ResidentStaleGeneration.code()),
        "a generation that is not the current one"
    );
    assert_eq!(
        code(w.act_file(&n, OWNER_B, 0, coord, site, 2, 3, None)),
        Err(CE::ResidentNotCurrentAuthority.code()),
        "not the asset's owner"
    );
    {
        // an unguarded asset: the guard is what makes the generation follow
        // every transfer
        let saved = n.asset.try_borrow_data().unwrap().to_vec();
        let base = saved.len() - guarded_tail(0, &guard()).len();
        n.asset.try_borrow_mut_data().unwrap()[base..].fill(0);
        assert_eq!(
            code(w.act_file(&n, OWNER_A, 0, coord, site, 2, 3, None)),
            Err(CE::ResidentUnguarded.code())
        );
        n.asset
            .try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&saved);
    }
    assert_eq!((w.w.citizen_data(&n.m), payer.lamports()), before);
    assert!(records().is_empty());
    // The owner at the current generation files.
    assert_eq!(
        code(w.act_file(&n, OWNER_A, 0, coord, site, 2, 3, None)),
        Ok(())
    );
    let cd = w.w.citizen_data(&n.m);
    assert_eq!(
        wt::pending(&cd),
        Ok(CitizenTicket::Wide { bell: 1, slot: 2 })
    );
    assert_eq!(
        resident_citizen::resident_asset(&cd),
        Some(ASSET),
        "the resident fields are untouched"
    );
    let rec = WideTicket::read(&w.ticket(&n.m).try_borrow_data().unwrap()).unwrap();
    assert_eq!(rec.citizen, n.m.key);
    assert_eq!(payer.lamports(), before.1 - rent_t - rent_w);
    assert_eq!(records().len(), 1, "the anchor's HARVEST");
    // A transfer: the previous owner is refused at both generations; the
    // new owner acts at the new one (and finds the ticket open).
    n.transfer(&OWNER_B);
    assert_eq!(
        code(w.act_file(&n, OWNER_A, 0, coord, site, 3, 3, None)),
        Err(CE::ResidentStaleGeneration.code())
    );
    assert_eq!(
        code(w.act_file(&n, OWNER_A, 1, coord, site, 3, 3, None)),
        Err(CE::ResidentNotCurrentAuthority.code())
    );
    assert_eq!(
        code(w.act_file(&n, OWNER_B, 1, coord, site, 3, 3, None)),
        Err(E::TicketState as u32),
        "authorized: the ticket is open"
    );
    // The settle names no actor: the new holder's ticket settles fresh.
    assert_eq!(code(w.settle(&n.m, 0, coord, site, 1, None)), Ok(()));
    let hd = w.holding_data(coord, site);
    assert_eq!(WideHolding::read(&hd).unwrap().owner_citizen, n.m.key);
    assert_eq!(
        wh::binding_of(&w.w.citizen_data(&n.m), 2),
        Ok(wh::SlotBinding::Wide)
    );
    let rec = w.record(&n.m);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder),
        (TicketStatus::Settled, 0, PAYER),
        "the record stays with the Citizen, not with the holder"
    );
    // A second ticket (slot 3) stays pending into the season's end. The
    // slot-2 holding must be final for it: at bell 3 its time has come
    // (past `final_ts`, the cohort settled); the third holding's settler
    // cost is 1.5× the base, so the anchor is restocked. The new holder's
    // act reuses the Citizen's Settled record: its escrow is empty, so the
    // payer tops up the wide rent and is the funder.
    at_bell(3);
    let pd = w.province_data(coord);
    let site2 = (0..pd[PV::SITE_COUNT])
        .find(|x| pd[PV::site(*x as usize) + SM::STATE] == SM::STATE_FREE)
        .expect("a free site");
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    w.set_stores(3, 3_000 * MILLI);
    let payer_before = payer.lamports();
    assert_eq!(
        code(w.act_file(&n, OWNER_B, 1, coord, site2, 3, 3, Some((coord, site)))),
        Ok(())
    );
    records();
    let rec = w.record(&n.m);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.slot, rec.site),
        (TicketStatus::Open, rent_w, PAYER, 3, site2)
    );
    assert_eq!(w.ticket(&n.m).lamports(), rent_t + rent_w);
    assert_eq!(payer.lamports(), payer_before - rent_w, "the top-up only");
    let payer_before = payer.lamports();
    // Aborted: CloseCitizen refuses while the wide ticket is pending; the
    // wide close returns the record; then the Citizen closes.
    w.set_status(S::STATUS_ABORTED);
    assert_eq!(
        w.close_citizen(&n.m, payer.clone()),
        Err(E::TicketState as u32)
    );
    let other = wallet(PAYER2, false, true, 0);
    assert_eq!(
        code(w.close_ticket(&n.m, payer.clone(), Some(other.clone()))),
        Err(E::BadAddress as u32),
        "not the funder"
    );
    assert_eq!(
        code(w.close_ticket(&n.m, other, Some(payer.clone()))),
        Err(E::BadAddress as u32),
        "not the rent payer"
    );
    assert_eq!(
        code(w.close_ticket(&n.m, payer.clone(), None)),
        Err(E::TooManyAccounts as u32),
        "an escrow needs its funder listed"
    );
    assert_eq!(
        code(w.close_ticket(&n.m, payer.clone(), Some(payer.clone()))),
        Ok(())
    );
    assert!(absent(&w.ticket(&n.m)));
    assert_eq!(
        payer.lamports(),
        payer_before + rent_t + rent_w,
        "the record's rent and the escrow, one payer"
    );
    let cd = w.w.citizen_data(&n.m);
    assert_eq!(wt::pending(&cd), Ok(CitizenTicket::None));
    assert_eq!(cd[C2::SLOTS] & C2::SLOTS_TICKET_MASK, 0);
    assert_eq!(
        code(w.close_ticket(&n.m, payer.clone(), Some(payer.clone()))),
        Err(E::NoTicket as u32)
    );
    assert_eq!(w.close_citizen(&n.m, payer.clone()), Ok(()));
    assert!(absent(&n.m.citizen));
    // The wide holding closes to its rent payer under Aborted as well.
    assert_eq!(code(w.close_holding(coord, site, payer.clone())), Ok(()));
    assert!(absent(&w.holding(coord, site)));
}

/// The deployed escrow's life over the wide record (FileOutpost's top-up
/// and funder rule, SettleTicket's retention, CloseCitizen's refund): an
/// expired ticket keeps the wide rent in its Settled record and nothing
/// goes back while the Season runs (no close before season end); a refile
/// by **another payer** over the retained rent tops up nothing and leaves
/// the funder, and the win's holding is paid for by that funder (its rent
/// payer), not by the refiler; a refile over an **empty** escrow by another
/// payer tops up exactly the wide rent and becomes the funder; the **same
/// payer** again tops up nothing; another payer over its retained rent
/// again tops up nothing and never takes the funder; at season end (Ended
/// + 72 h) a Settled record closes in CloseCitizen's shape **before** its
/// Citizen (the Citizen present, nothing on it changes) or **after**
/// CloseCitizen (the Citizen position absent): the record's rent to the
/// payer that created it, the escrow to the payer that last topped it up
/// (A creates and wins, B tops up for a refile that expires: A gets the
/// record's rent, B the retained escrow, exact balances), swapped
/// recipients, a missing funder and a replay refused; the holding closes
/// to the funder that paid it.
#[test]
fn wide_land_ticket_escrow_is_retained_reused_and_returned_as_the_deployed_escrow() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    let (_, nation) = off_wedge_province();
    let b = w.w.member(WALLET_B, (nation + 1) % 6);
    w.fixture_rim_home(&a, &template, 0, 3_000 * MILLI);
    w.fixture_rim_home(&b, &template, 1, 3_000 * MILLI);
    let payer = w.w.payer.clone();
    let payer2 = w.wallet_of(PAYER2);
    let rent_t = crate::init::rent(wt::wide_ticket::SIZE).unwrap();
    let rent_w = crate::init::rent(wh::wide_holding::SIZE).unwrap();
    let (p1, p2) = (payer.lamports(), payer2.lamports());

    // Bell 1: the payer files for a; nobody settles for 24 bells. Expired:
    // the record retains the wide rent, Settled, for its funder.
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)),
        Ok(())
    );
    records();
    at_bell(1 + PV::COHORT_BELLS);
    assert_eq!(code(w.settle(&a, 0, coord, site, 1, None)), Ok(()));
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.citizen),
        (TicketStatus::Settled, rent_w, PAYER, a.key)
    );
    assert_eq!(w.ticket(&a).lamports(), rent_t + rent_w, "retained");
    assert_eq!(payer.lamports(), p1 - rent_t - rent_w, "nothing back");
    assert!(absent(&w.holding(coord, site)));
    assert_eq!(wt::pending(&w.w.citizen_data(&a)), Ok(CitizenTicket::None));
    assert_eq!(
        code(w.close_ticket(&a, payer.clone(), Some(payer.clone()))),
        Err(E::WrongStatus as u32),
        "no reclaim while the Season runs, as deployed"
    );
    assert_eq!(
        code(w.settle(&a, 0, coord, site, 1, None)),
        Err(E::NoTicket as u32)
    );
    assert_eq!(w.legacy_settle(&a), Err(E::NoTicket as u32));
    assert_eq!(
        Ro(&w.w.citizen_data(&a)).u64(C::TICKET_ESCROW).unwrap(),
        0,
        "the deployed escrow never held it"
    );

    // Bell 25: another payer refiles a over the retained rent: no top-up,
    // the funder stays the original payer (FileOutpost: the payer becomes
    // the funder only when it tops up).
    let bell_a = 1 + PV::COHORT_BELLS;
    w.set_stores(0, 3_000 * MILLI);
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer2.clone(), None)),
        Ok(())
    );
    records();
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.bell, rec.site, rec.slot),
        (TicketStatus::Open, rent_w, PAYER, bell_a, site, 2)
    );
    assert_eq!(w.ticket(&a).lamports(), rent_t + rent_w);
    assert_eq!(
        payer2.lamports(),
        p2,
        "no shortfall: the other payer paid nothing"
    );
    assert_eq!(payer.lamports(), p1 - rent_t - rent_w);
    assert_eq!(
        wt::pending(&w.w.citizen_data(&a)),
        Ok(CitizenTicket::Wide {
            bell: bell_a,
            slot: 2
        })
    );
    assert_eq!(w.legacy_settle(&a), Err(E::TicketState as u32));
    // The win consumes exactly the wide rent of the escrow; the holding's
    // rent payer is the funder, not the refiler.
    assert_eq!(code(w.settle(&a, 0, coord, site, bell_a, None)), Ok(()));
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder),
        (TicketStatus::Settled, 0, PAYER)
    );
    assert_eq!(w.ticket(&a).lamports(), rent_t);
    assert_eq!(w.holding(coord, site).lamports(), rent_w);
    assert_eq!(
        &w.holding_data(coord, site)[H::RENT_PAYER..H::RENT_PAYER + 32],
        &PAYER,
        "the funder paid the holding"
    );
    assert_eq!(payer2.lamports(), p2);
    assert_eq!(payer.lamports(), p1 - rent_t - rent_w);
    assert_eq!(
        wh::binding_of(&w.w.citizen_data(&a), 2),
        Ok(wh::SlotBinding::Wide)
    );

    // Bell 27 (slot 2 final): the other payer refiles a into slot 3 over
    // an empty escrow: the whole wide rent is the top-up (the record's own
    // rent is never paid twice) and it becomes the funder. Expired again:
    // retained for the new funder.
    let bell_b = bell_a + 2;
    at_bell(bell_b);
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    let pd = w.province_data(coord);
    let site3 = (0..pd[PV::SITE_COUNT])
        .find(|x| *x != site && pd[PV::site(*x as usize) + SM::STATE] == SM::STATE_FREE)
        .expect("a free site");
    w.set_stores(0, 3_000 * MILLI);
    assert_eq!(
        code(w.file(
            &a,
            WALLET_A,
            coord,
            site3,
            3,
            0,
            payer2.clone(),
            Some((coord, site))
        )),
        Ok(())
    );
    records();
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.bell, rec.site, rec.slot),
        (TicketStatus::Open, rent_w, PAYER2, bell_b, site3, 3)
    );
    assert_eq!(w.ticket(&a).lamports(), rent_t + rent_w);
    assert_eq!(
        payer2.lamports(),
        p2 - rent_w,
        "the top-up: the wide rent only"
    );
    assert_eq!(payer.lamports(), p1 - rent_t - rent_w);
    let bell_c = bell_b + PV::COHORT_BELLS;
    at_bell(bell_c);
    assert_eq!(code(w.settle(&a, 0, coord, site3, bell_b, None)), Ok(()));
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder),
        (TicketStatus::Settled, rent_w, PAYER2)
    );
    assert!(absent(&w.holding(coord, site3)));
    assert_eq!(w.w.citizen_data(&a)[C::HOLDINGS_N], 2);

    // Bell 51: the same payer refiles over its retained rent: no top-up,
    // the funder stays. Expired.
    w.set_stores(0, 3_000 * MILLI);
    assert_eq!(
        code(w.file(
            &a,
            WALLET_A,
            coord,
            site3,
            3,
            0,
            payer2.clone(),
            Some((coord, site))
        )),
        Ok(())
    );
    records();
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.bell),
        (TicketStatus::Open, rent_w, PAYER2, bell_c)
    );
    assert_eq!(
        payer2.lamports(),
        p2 - rent_w,
        "the same payer paid nothing more"
    );
    let bell_d = bell_c + PV::COHORT_BELLS;
    at_bell(bell_d);
    assert_eq!(code(w.settle(&a, 0, coord, site3, bell_c, None)), Ok(()));
    assert_eq!(w.record(&a).escrow, rent_w);

    // Bell 75: the original payer refiles over the other payer's retained
    // rent: no top-up, and the funder is **not** taken from the payer that
    // last topped up. Member b files its first ticket (the payer) on a
    // third site. Both expire.
    w.set_stores(0, 3_000 * MILLI);
    assert_eq!(
        code(w.file(
            &a,
            WALLET_A,
            coord,
            site3,
            3,
            0,
            payer.clone(),
            Some((coord, site))
        )),
        Ok(())
    );
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.bell),
        (TicketStatus::Open, rent_w, PAYER2, bell_d)
    );
    assert_eq!(
        payer.lamports(),
        p1 - rent_t - rent_w,
        "nothing paid, nothing taken"
    );
    assert_eq!(payer2.lamports(), p2 - rent_w);
    let pd = w.province_data(coord);
    let site_b = (0..pd[PV::SITE_COUNT])
        .find(|x| *x != site3 && pd[PV::site(*x as usize) + SM::STATE] == SM::STATE_FREE)
        .expect("a free site");
    assert_eq!(
        code(w.file(&b, WALLET_B, coord, site_b, 2, 1, payer.clone(), None)),
        Ok(())
    );
    records();
    assert_eq!(payer.lamports(), p1 - 2 * (rent_t + rent_w));
    at_bell(bell_d + PV::COHORT_BELLS);
    assert_eq!(code(w.settle(&a, 0, coord, site3, bell_d, None)), Ok(()));
    assert_eq!(code(w.settle(&b, 0, coord, site_b, bell_d, None)), Ok(()));
    let (ra, rb) = (w.record(&a), w.record(&b));
    assert_eq!(
        (ra.status, ra.escrow, ra.funder, ra.rent_payer),
        (TicketStatus::Settled, rent_w, PAYER2, PAYER),
        "a's record: created by the payer, last topped up by the other"
    );
    assert_eq!(
        (rb.status, rb.escrow, rb.funder, rb.rent_payer),
        (TicketStatus::Settled, rent_w, PAYER, PAYER)
    );
    assert_eq!(payer.lamports(), p1 - 2 * (rent_t + rent_w));
    assert_eq!(payer2.lamports(), p2 - rent_w);
    assert!(records().is_empty());

    // Season end (Ended + 72 h). b: the Settled record closes first, the
    // Citizen present and untouched; then CloseCitizen. One payer created
    // it and funded it: both positions name it and it gets the whole.
    w.set_status(S::STATUS_ENDED);
    let end = GENESIS + 200_000i64 * 600 + crate::proc::map::END_GRACE_SECS;
    crate::prologue::set_test_clock(end - 1, 5_000);
    assert_eq!(
        code(w.close_ticket(&b, payer.clone(), Some(payer.clone()))),
        Err(E::TooEarly as u32)
    );
    crate::prologue::set_test_clock(end, 5_001);
    let b_before = w.w.citizen_data(&b);
    assert_eq!(
        code(w.close_ticket(&b, payer.clone(), Some(payer2.clone()))),
        Err(E::BadAddress as u32),
        "not the funder"
    );
    assert_eq!(
        code(w.close_ticket(&b, payer2.clone(), Some(payer.clone()))),
        Err(E::BadAddress as u32),
        "not the rent payer"
    );
    assert_eq!(
        code(w.close_ticket(&b, payer.clone(), Some(payer.clone()))),
        Ok(())
    );
    assert!(absent(&w.ticket(&b)));
    assert_eq!(
        payer.lamports(),
        p1 - (rent_t + rent_w),
        "b's record whole to its one payer"
    );
    assert_eq!(w.w.citizen_data(&b), b_before, "nothing on the Citizen");
    assert_eq!(
        code(w.close_ticket(&b, payer.clone(), Some(payer.clone()))),
        Err(E::NoTicket as u32)
    );
    // These Citizens were pre-funded fixtures, not paid from p1.
    let citizen_fixture_refunds = a.citizen.lamports() + b.citizen.lamports();
    assert_eq!(w.close_citizen(&b, payer.clone()), Ok(()));
    assert!(absent(&b.citizen));
    // a: CloseCitizen runs first (no marker: the deployed close has no
    // wide ticket to refuse), then the Settled record closes with the
    // absent Citizen in its position. Two recipients, as CloseCitizen's:
    // the record's rent to the payer that created it, the escrow to the
    // other payer that last topped it up; swapped positions refused; the
    // Citizen's deletion redirected nothing.
    assert_eq!(w.close_citizen(&a, payer.clone()), Ok(()));
    assert!(absent(&a.citizen));
    let rec = w.record(&a);
    assert_eq!(
        (rec.status, rec.escrow, rec.funder, rec.rent_payer),
        (TicketStatus::Settled, rent_w, PAYER2, PAYER)
    );
    assert_eq!(
        code(w.close_ticket(&a, payer2.clone(), Some(payer.clone()))),
        Err(E::BadAddress as u32),
        "swapped: the other payer is not the rent payer"
    );
    assert_eq!(
        code(w.close_ticket(&a, payer.clone(), Some(payer.clone()))),
        Err(E::BadAddress as u32),
        "the creator is not the funder"
    );
    assert_eq!(
        code(w.close_ticket(&a, payer.clone(), None)),
        Err(E::TooManyAccounts as u32),
        "an escrow needs its funder listed"
    );
    let (pa, pb) = (payer.lamports(), payer2.lamports());
    assert_eq!(
        code(w.close_ticket(&a, payer.clone(), Some(payer2.clone()))),
        Ok(())
    );
    assert!(absent(&w.ticket(&a)));
    assert_eq!(
        payer.lamports(),
        pa + rent_t,
        "the record's rent to its creator"
    );
    assert_eq!(payer2.lamports(), pb + rent_w, "the escrow to its funder");
    assert_eq!(
        payer2.lamports(),
        p2,
        "the other payer only ever topped up the escrow, and has it all back"
    );
    assert_eq!(
        code(w.close_ticket(&a, payer.clone(), Some(payer2.clone()))),
        Err(E::NoTicket as u32),
        "replay"
    );
    // The wide holding closes to the funder that paid it at the win.
    assert_eq!(
        code(w.close_holding(coord, site, payer2.clone())),
        Err(E::BadAddress as u32)
    );
    assert_eq!(code(w.close_holding(coord, site, payer.clone())), Ok(()));
    assert!(absent(&w.holding(coord, site)));
    assert_eq!(
        payer.lamports(),
        p1 + citizen_fixture_refunds,
        "wide costs returned, plus the separately funded Citizen fixtures"
    );
    records();
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
    assert_eq!(w.place_home(&a, c, 0), Err(E::TicketState as u32));
    assert!(records().is_empty());
    assert_eq!(w.province_data(c)[PV::N_SITES_USED], 0);
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
    assert_eq!(w.place_home(&a, c, 1), Err(E::AlreadyDone as u32));
}
