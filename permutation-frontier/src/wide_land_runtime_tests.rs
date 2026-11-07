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
use frontier_abi::clash_model::Camp;
use frontier_abi::conquest_model::read_keep;
use frontier_abi::entry::{read_entry, write_entry, EntryOp};
use frontier_abi::ix::HINTS_LEN;
use frontier_abi::resident_auth::Policy;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::world_index::arrival as wa;
use frontier_abi::world_index::event::{self as wev, WideEntity, WideKind, WideRecord};
use frontier_abi::world_index::holding::{self as wh, WideHolding, HOST_IDENTITY_UNALLOCATED};
use frontier_abi::world_index::land::{
    self as wl, readiness, SeedStatus, WideProvince, WideRingSeed, WideRules, FIRST_WIDE_RING,
};
use frontier_abi::world_index::march::{wide_host_alias, HOST_IDENTITY_FULL_REF_V1};
use frontier_abi::world_index::placement::mixed_home_nation;
use frontier_abi::world_index::roster::{self as wro, WideRoster};
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
    bell_anchor as BA, camp as CP, cohort as CO, entry as EN, join_shard2 as JS2, seed_cache as SC,
    summary as SU,
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
///
/// **Transaction-status filtering of the log collectors.** Raw logs may
/// remain on a failed transaction, but are not successful game receipts.
/// Consumers must check transaction status. The collectors (`LOGS` for PS2, `WIDE_LOGS`
/// for `PSW1`) emulate that: their lengths are noted before the dispatch
/// and truncated back on a refusal, so [`records`] and [`wide_records`]
/// return the receipts of **successful** transactions only, and a record a
/// handler logged before a later step refused is never mistaken for an
/// event.
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
    let (n_logs, n_wide) = (LOGS.lock().unwrap().len(), WIDE_LOGS.lock().unwrap().len());
    match crate::dispatch(&Pubkey::new_from_array(PROGRAM), accounts, data) {
        Ok(()) => Ok(()),
        Err(e) => {
            LOGS.lock().unwrap().truncate(n_logs);
            WIDE_LOGS.lock().unwrap().truncate(n_wide);
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
    rosters: HashMap<(i64, i64), AccountInfo<'static>>,
    /// The wide transit records `(coord, site, slot)` of a holding.
    transits: HashMap<(i64, i64, u8, u8), AccountInfo<'static>>,
    /// The wide ArrivalSlots `(dest, bell, faction, i)`.
    slots: HashMap<(i64, i64, u32, u8, u8), AccountInfo<'static>>,
    /// The wide ClashInputs `(dest, bell)`.
    inputs: HashMap<(i64, i64, u32), AccountInfo<'static>>,
    /// The wide ArrivalDays `(dest, day)`.
    days: HashMap<(i64, i64, u32), AccountInfo<'static>>,
    /// The beacon logs per region (a fixture: nothing posted).
    logs: HashMap<u8, AccountInfo<'static>>,
    /// The absent anchor archives `(region, part)`.
    archives: HashMap<(u8, u32), AccountInfo<'static>>,
    /// The instructions sysvar fixture.
    sysvar: Option<AccountInfo<'static>>,
    /// Stage beacons under the T model ([`Wide::beacon_rounds`]).
    beacon_t: bool,
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
            rosters: HashMap::new(),
            transits: HashMap::new(),
            slots: HashMap::new(),
            inputs: HashMap::new(),
            days: HashMap::new(),
            logs: HashMap::new(),
            archives: HashMap::new(),
            sysvar: None,
            beacon_t: false,
        }
    }

    /// The Season's genesis as stored (every time helper derives from it,
    /// so a test that patches the Season's genesis stays consistent).
    fn genesis(&self) -> i64 {
        self.clock().genesis_ts
    }

    /// Sets the Clock to `secs` into bell `bell` of **the Season's**
    /// genesis (slot `1_000 + bell`); returns the timestamp.
    fn at(&self, bell: u32, secs: i64) -> i64 {
        let ts = self.genesis() + 600 * bell as i64 + secs;
        crate::prologue::set_test_clock(ts, 1_000 + bell as u64);
        ts
    }

    /// THE anchor's `A` and the rounds a staged beacon of `bell` carries:
    /// `(a, anchor round, cache round)`. The default model (every test):
    /// `A = bell start + 100` and both rounds `S(bell, A)` (a fixture: the
    /// anchor lands before the bell ends). The **T model** (`beacon_t`):
    /// the anchor's round is `T(bell)`, the round-T signature's, and `A =
    /// round_time(T(bell)) + 30` — after the bell's end, as a real anchor
    /// lands; the cache's round is `S(bell, A)`.
    fn beacon_rounds(&self, bell: u32) -> (i64, u64, u64) {
        let c = self.clock();
        if self.beacon_t {
            let t = c.tlock_round(bell);
            let a = c.round_time(t) + 30;
            (a, t, c.seed_round(bell, a))
        } else {
            let a = c.genesis_ts + 600 * bell as i64 + 100;
            let s = c.seed_round(bell, a);
            (a, s, s)
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
        let (a, anchor_round, round) = self.beacon_rounds(bell);
        let anchor_key = self.w.ctx.bell_anchor(bell, region);
        let mut ad = vec![0u8; K2::BellAnchor.size()];
        assert!(frontier_abi::v2::layout::write_header(
            &mut ad,
            K2::BellAnchor,
            SEASON_ID
        ));
        put(&mut ad, BA::BELL, &bell.to_le_bytes());
        ad[BA::REGION] = region;
        put(&mut ad, BA::ROUND, &anchor_round.to_le_bytes());
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

    /// [`Wide::stage_seed`] under the T model with THE anchor's `sig48`
    /// set: the anchor of `(bell, region)` carries the round `T(bell)`, an
    /// `A` after the bell's end, and `sig48` — which the caller has
    /// verified to be the round-T signature (the native settle test
    /// verifies it against the production key before staging). The
    /// SeedCache's round is `S(bell, A)` and its seed stays the literal
    /// `seed` (a fixture: the round-S signature is not available, so the
    /// seed's provenance is not shown). Must run before any reader stages
    /// the unsigned pair of `(bell, region)`.
    #[cfg(all(
        feature = "native-crypto-tests",
        not(feature = "test-beacon"),
        not(target_os = "solana")
    ))]
    fn stage_beacon_signed(
        &mut self,
        bell: u32,
        region: u8,
        seed: &[u8; 32],
        sig48: [u8; 48],
    ) -> (AccountInfo<'static>, AccountInfo<'static>) {
        assert!(self.beacon_t, "the T model");
        assert!(
            !self.beacons.contains_key(&(bell, region)),
            "the signed anchor is staged before any reader stages the unsigned one"
        );
        let pair = self.stage_seed(bell, region, seed);
        {
            let mut ad = pair.1.try_borrow_mut_data().unwrap();
            put(&mut ad, BA::SIG48, &sig48);
            ad[BA::NET] = crate::crypto::quick::NET_QUICKNET;
        }
        pair
    }

    /// `final_ts` the settle of a ticket of `bell` writes: `round_time(S) +
    /// 600` for the staged anchor.
    fn final_ts_of(&self, bell: u32) -> i64 {
        let c = self.clock();
        let (_, _, s) = self.beacon_rounds(bell);
        c.round_time(s) + 600
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

    /// 0xDA WideDepart of `host` from its holding by the member's wallet,
    /// the host standing in `standing` (the deployed Depart's `province`
    /// position: the holding's own wide province when it never left home,
    /// or a deployed Province to show the boundary refusal).
    fn depart(
        &mut self,
        m: &Member,
        host: WideHostRef,
        standing: AccountInfo<'static>,
        arrive_bell: u32,
    ) -> Result<(), u32> {
        let coord = host.key().coord();
        let roster = self.roster(coord);
        let mut seal = [0u8; frontier_abi::world_index::seal::WIDE_SEAL_LEN];
        seal[0] = 0x80;
        code(self.depart_with(m, host, standing, roster, 0, arrive_bell, [7u8; 32], seal))
    }

    /// WideDepart with every input named: the standing province and its
    /// roster, the transit slot (exactly that one of the four records
    /// writable), the commitment and the wide seal. The tip is the
    /// Season's floor.
    #[allow(clippy::too_many_arguments)]
    fn depart_with(
        &mut self,
        m: &Member,
        host: WideHostRef,
        standing: AccountInfo<'static>,
        roster: AccountInfo<'static>,
        transit_slot: u8,
        arrive_bell: u32,
        commit: [u8; 32],
        seal: [u8; frontier_abi::world_index::seal::WIDE_SEAL_LEN],
    ) -> Result<(), Refused> {
        let coord = host.key().coord();
        let site = host.site();
        let mut a = vec![
            wallet(m.wallet, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.holding(coord, site),
            standing,
            self.w.system.clone(),
            with_writable(&self.province(coord), false),
        ];
        for s in 0..4u8 {
            let t = self.transit(coord, site, s);
            a.push(with_writable(&t, s == transit_slot));
        }
        a.push(with_writable(&roster, false));
        run_tx(
            &a,
            &wix::Depart {
                host: host.to_bytes(),
                transit_slot,
                arrive_bell,
                tip: self.min_tip(),
                commit,
                seal,
            }
            .to_bytes(),
        )
    }

    /// The Season's tip floor (`fees::min_tip_lamports` over its fields).
    fn min_tip(&self) -> u64 {
        let sd = self.w.season.try_borrow_data().unwrap();
        let r = Ro(&sd);
        permutation_rules::frontier::fees::min_tip_lamports(
            r.u32(S::MIN_REVEAL_PRIORITY_MILLI).unwrap(),
            r.u32(S::REVEAL_CU_LIMIT).unwrap(),
            r.u32(S::REVEAL_LOADED_LIMIT).unwrap(),
        )
    }

    /// The wide transit record of slot `slot` of the holding at `(coord,
    /// site)`: absent at its canonical address until written (`cap` for
    /// the record).
    fn transit(&mut self, coord: WideCoord, site: u8, slot: u8) -> AccountInfo<'static> {
        let hk = wh::holding_address(&self.w.ctx, coord, site);
        let key = frontier_abi::world_index::march::transit_address(&self.w.ctx, &hk, slot);
        self.transits
            .entry((coord.p(), coord.q(), site, slot))
            .or_insert_with(|| {
                info(
                    leak(
                        key,
                        SYSTEM,
                        vec![],
                        frontier_abi::world_index::march::WIDE_TRANSIT_LEN,
                        0,
                    ),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// The wide ArrivalSlot `(dest, bell, faction, i)`: absent until a
    /// reveal creates it.
    fn slot(&mut self, dest: WideCoord, bell: u32, faction: u8, i: u8) -> AccountInfo<'static> {
        let key = wa::arrival_slot_address(
            &self.w.ctx,
            ProvinceKey::new(self.world_id(), dest),
            bell,
            faction,
            i,
        );
        self.slots
            .entry((dest.p(), dest.q(), bell, faction, i))
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wa::wide_arrival_slot::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// The wide ClashInputs `(dest, bell)`: absent until a gather creates
    /// it (writable, with room).
    fn inputs(&mut self, dest: WideCoord, bell: u32) -> AccountInfo<'static> {
        let key =
            wa::clash_inputs_address(&self.w.ctx, ProvinceKey::new(self.world_id(), dest), bell);
        self.inputs
            .entry((dest.p(), dest.q(), bell))
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wa::wide_clash_inputs::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// The wide ArrivalDay of `(dest, day_of(bell))`: absent until a reveal
    /// creates it.
    fn day(&mut self, dest: WideCoord, bell: u32) -> AccountInfo<'static> {
        let day = wa::day_of(bell);
        let key =
            wa::arrival_day_address(&self.w.ctx, ProvinceKey::new(self.world_id(), dest), day);
        self.days
            .entry((dest.p(), dest.q(), day))
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wa::wide_arrival_day::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// **Fixture**: the beacon log of `region` as InitBeaconLogs leaves it
    /// with nothing posted (`latest_round` 0): the reveal's seed-round
    /// check reads it.
    fn beacon_log(&mut self, region: u8) -> AccountInfo<'static> {
        let key = self.w.ctx.beacon_log(region);
        self.logs
            .entry(region)
            .or_insert_with(|| {
                let mut d = vec![0u8; K2::BeaconLog.size()];
                assert!(frontier_abi::v2::layout::write_header(
                    &mut d,
                    K2::BeaconLog,
                    SEASON_ID
                ));
                d[crate::layout::beacon_log::REGION] = region;
                info(leak(key, PROGRAM, d, 0, BIG), false, false)
            })
            .clone()
    }

    /// The absent AnchorArchive of `(region, part(bell))` (one account per
    /// key, see [`Wide::no_inputs`]).
    fn no_archive(&mut self, region: u8, bell: u32) -> AccountInfo<'static> {
        let part = frontier_abi::addr::archive_part_of(bell);
        let key = self.w.ctx.anchor_archive(region, part);
        self.archives
            .entry((region, part))
            .or_insert_with(|| info(leak(key, SYSTEM, vec![], 0, 0), false, false))
            .clone()
    }

    /// **Fixture**: the instructions sysvar of a transaction with one
    /// instruction (this one) and no ComputeBudget instruction, in the
    /// runtime's serialized form (`evidence::parse`): the evidence is then
    /// the landing slot alone. One account per key.
    fn ix_sysvar(&mut self) -> AccountInfo<'static> {
        self.sysvar
            .get_or_insert_with(|| {
                let mut d = vec![1u8, 0, 4, 0, 0, 0];
                d.extend_from_slice(&PROGRAM);
                d.extend_from_slice(&[0, 0, 0, 0]);
                info(
                    leak(
                        frontier_abi::prologue::ids::INSTRUCTIONS_SYSVAR,
                        SYSTEM,
                        d,
                        0,
                        0,
                    ),
                    false,
                    false,
                )
            })
            .clone()
    }

    /// The roster side table of `coord`: absent at its canonical draft
    /// address until the first WideMuster creates it.
    fn roster(&mut self, coord: WideCoord) -> AccountInfo<'static> {
        let key = wro::roster_address(&self.w.ctx, ProvinceKey::new(self.world_id(), coord));
        self.rosters
            .entry((coord.p(), coord.q()))
            .or_insert_with(|| {
                info(
                    leak(key, SYSTEM, vec![], wro::wide_roster::SIZE, 0),
                    false,
                    true,
                )
            })
            .clone()
    }

    /// The wide ClashInputs position of `(coord, bell)` as it stands
    /// (absent until a gather creates it), read-only. **One account per
    /// key**: `leak` registers a key's buffer in the harness's memory
    /// table and a second leak of the same key would replace it, so the
    /// stub's later allocation of the real record would find the wrong
    /// capacity after the rent had moved.
    fn no_inputs(&mut self, coord: WideCoord, bell: u32) -> AccountInfo<'static> {
        with_writable(&self.inputs(coord, bell), false)
    }

    /// The account list of a WideMuster for the member's wide holding at
    /// `(coord, site)`.
    fn muster_accounts(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        coord: WideCoord,
        site: u8,
        province: AccountInfo<'static>,
    ) -> Vec<AccountInfo<'static>> {
        vec![
            wallet(actor, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.holding(coord, site),
            province,
            self.roster(coord),
            self.w.system.clone(),
        ]
    }

    /// WideMuster (0xDA op 1) of `troops` of `unit` onto `tile` from the
    /// member's wide holding at `(coord, site)`, by `actor`.
    #[allow(clippy::too_many_arguments)]
    fn muster(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        coord: WideCoord,
        site: u8,
        unit: u8,
        troops: u32,
        tile: u8,
    ) -> Result<(), Refused> {
        let province = self.province(coord);
        let a = self.muster_accounts(m, actor, coord, site, province);
        run_tx(&a, &wix::Muster { unit, troops, tile }.to_bytes())
    }

    /// WideDissolve (0xDA op 2) of `host` by the member's wallet, the host
    /// standing in `standing`.
    fn dissolve(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        host: WideHostRef,
        standing: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let coord = host.key().coord();
        let roster = self.roster(coord);
        self.dissolve_at(m, actor, host, standing, roster)
    }

    /// WideDissolve of `host` standing in `standing` whose roster is
    /// `roster` (a foreign province when they are not the holding's own);
    /// the holding's own province and its four transit records follow.
    fn dissolve_at(
        &mut self,
        m: &Member,
        actor: [u8; 32],
        host: WideHostRef,
        standing: AccountInfo<'static>,
        roster: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let coord = host.key().coord();
        let site = host.site();
        let mut a = vec![
            wallet(actor, true, false, 0),
            self.w.payer.clone(),
            self.w.season.clone(),
            m.citizen.clone(),
            self.holding(coord, site),
            standing,
            with_writable(&roster, false),
            with_writable(&self.province(coord), false),
        ];
        for s in 0..4u8 {
            let t = self.transit(coord, site, s);
            a.push(with_writable(&t, false));
        }
        run_tx(
            &a,
            &wix::Dissolve {
                host: host.to_bytes(),
            }
            .to_bytes(),
        )
    }

    /// The wide transit record of slot `slot` of the holding at `hkey`
    /// (the test's account of it when one exists, else an absent account
    /// at the canonical address).
    fn transit_by_key(&mut self, hkey: &[u8; 32], slot: u8) -> AccountInfo<'static> {
        let key = frontier_abi::world_index::march::transit_address(&self.w.ctx, hkey, slot);
        match self.transits.values().find(|a| a.key.as_array() == &key) {
            Some(a) => a.clone(),
            None => info(leak(key, SYSTEM, vec![], 0, 0), false, false),
        }
    }

    /// WideResolve (0xDC op 1) of `bell` of `coord` by the payer, the
    /// beacon of `(bell, region)` staged.
    fn resolve(&mut self, coord: WideCoord, bell: u32) -> Result<(), Refused> {
        let region = WideProvince::read(&self.province_data(coord))
            .map(|p| p.region)
            .unwrap_or(0);
        let beacon = self.stage_seed(bell, region, &BELL_SEED);
        self.resolve_with(coord, bell, beacon)
    }

    /// [`Wide::resolve`] with the `(seed cache, anchor)` pair given.
    fn resolve_with(
        &mut self,
        coord: WideCoord,
        bell: u32,
        beacon: (AccountInfo<'static>, AccountInfo<'static>),
    ) -> Result<(), Refused> {
        let inputs = self.no_inputs(coord, bell);
        self.resolve_full(coord, bell, beacon, inputs)
    }

    /// [`Wide::resolve_with`] with the ClashInputs position given; the
    /// arrival evidence is the wide ArrivalDay of `(coord, bell)` as it
    /// stands (absent until a reveal).
    fn resolve_full(
        &mut self,
        coord: WideCoord,
        bell: u32,
        beacon: (AccountInfo<'static>, AccountInfo<'static>),
        inputs: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        self.resolve_full_as(coord, bell, beacon, inputs, PAYER)
    }

    /// [`Wide::resolve_full`] with the instruction's beneficiary (the
    /// resolver a gathered record names) given.
    fn resolve_full_as(
        &mut self,
        coord: WideCoord,
        bell: u32,
        (cache, anchor): (AccountInfo<'static>, AccountInfo<'static>),
        inputs: AccountInfo<'static>,
        beneficiary: [u8; 32],
    ) -> Result<(), Refused> {
        let day = with_writable(&self.day(coord, bell), false);
        let a = [
            self.w.payer.clone(),
            self.w.season.clone(),
            self.province(coord),
            self.roster(coord),
            cache,
            anchor,
            inputs,
            day,
            self.w.system.clone(),
        ];
        run_tx(&a, &wix::Resolve { bell, beneficiary }.to_bytes())
    }

    /// [`Wide::resolve`] over the gathered record of `(coord, bell)` (the
    /// arrival path).
    fn resolve_gathered(&mut self, coord: WideCoord, bell: u32) -> Result<(), Refused> {
        self.resolve_gathered_as(coord, bell, PAYER)
    }

    /// [`Wide::resolve_gathered`] with the resolver (the instruction's
    /// beneficiary) given.
    fn resolve_gathered_as(
        &mut self,
        coord: WideCoord,
        bell: u32,
        beneficiary: [u8; 32],
    ) -> Result<(), Refused> {
        let region = WideProvince::read(&self.province_data(coord))
            .map(|p| p.region)
            .unwrap_or(0);
        let beacon = self.stage_seed(bell, region, &BELL_SEED);
        let inputs = self.inputs(coord, bell);
        self.resolve_full_as(coord, bell, beacon, inputs, beneficiary)
    }

    /// WideReturn (0xDC op 2) of `coord`'s departed hosts of `holding`.
    fn settle_return(
        &mut self,
        coord: WideCoord,
        holding: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        self.settle_return_from(coord, holding, None)
    }

    /// [`Wide::settle_return`] with the holding's own province named (a
    /// return from a province other than it).
    fn settle_return_from(
        &mut self,
        coord: WideCoord,
        holding: AccountInfo<'static>,
        own: Option<AccountInfo<'static>>,
    ) -> Result<(), Refused> {
        let hkey = *holding.key.as_array();
        let mut a = vec![
            self.w.payer.clone(),
            self.w.season.clone(),
            self.province(coord),
            self.roster(coord),
            holding,
        ];
        for s in 0..4u8 {
            let t = self.transit_by_key(&hkey, s);
            a.push(with_writable(&t, false));
        }
        if let Some(o) = own {
            a.push(with_writable(&o, false));
        }
        run_tx(&a, &wix::Return.to_bytes())
    }

    /// WideSettleDeparture (0xDC op 3) of `host`'s `slot` from `origin`.
    fn settle_departure(
        &mut self,
        host: WideHostRef,
        origin: WideCoord,
        slot: u8,
    ) -> Result<(), Refused> {
        let coord = host.key().coord();
        let a = [
            self.w.payer.clone(),
            self.w.season.clone(),
            self.province(origin),
            self.holding(coord, host.site()),
            self.roster(origin),
            self.transit(coord, host.site(), slot),
        ];
        run_tx(
            &a,
            &wix::SettleDeparture {
                host: host.to_bytes(),
                transit_slot: slot,
            }
            .to_bytes(),
        )
    }

    /// WideReveal (0xEE) of `host`'s `slot` at `dest` for `arrive`, the
    /// path provinces given in first-entered order.
    #[allow(clippy::too_many_arguments)]
    fn reveal(
        &mut self,
        host: WideHostRef,
        slot: u8,
        dest: WideCoord,
        arrive: u32,
        target_i: u8,
        plain: [u8; frontier_abi::world_index::seal::WIDE_PLAIN_LEN],
        salt: [u8; 32],
        ct_hash: [u8; 32],
        path: &[WideCoord],
    ) -> Result<(), Refused> {
        self.reveal_as(
            host, slot, dest, arrive, target_i, plain, salt, ct_hash, path, PAYER,
        )
    }

    /// [`Wide::reveal`] with the slot's beneficiary (the instruction's)
    /// given.
    #[allow(clippy::too_many_arguments)]
    fn reveal_as(
        &mut self,
        host: WideHostRef,
        slot: u8,
        dest: WideCoord,
        arrive: u32,
        target_i: u8,
        plain: [u8; frontier_abi::world_index::seal::WIDE_PLAIN_LEN],
        salt: [u8; 32],
        ct_hash: [u8; 32],
        path: &[WideCoord],
        beneficiary: [u8; 32],
    ) -> Result<(), Refused> {
        let coord = host.key().coord();
        let region = WideProvince::read(&self.province_data(dest))
            .map(|p| p.region)
            .unwrap_or(0);
        let (_, anchor) = self.stage_seed(arrive, region, &BELL_SEED);
        let faction = {
            let d = self.transit(coord, host.site(), slot);
            let t = d.try_borrow_data().unwrap();
            frontier_abi::world_index::march::WideTransit::from_bytes(&t)
                .map(|t| t.faction)
                .unwrap_or(0)
        };
        let mut a = vec![
            self.w.payer.clone(),
            self.w.season.clone(),
            with_writable(&self.holding(coord, host.site()), false),
            with_writable(&self.transit(coord, host.site(), slot), false),
            anchor,
            self.no_archive(region, arrive),
            self.beacon_log(region),
            with_writable(&self.inputs(dest, arrive), false),
            with_writable(&self.province(dest), false),
            self.day(dest, arrive),
        ];
        for i in 0..4u8 {
            let s = self.slot(dest, arrive, faction, i);
            a.push(with_writable(&s, i == target_i));
        }
        a.push(self.ix_sysvar());
        a.push(self.w.system.clone());
        for p in path {
            a.push(with_writable(&self.province(*p), false));
        }
        run_tx(
            &a,
            &wix::Reveal {
                transit_slot: slot,
                target_i,
                plain,
                salt,
                ct_hash,
                beneficiary,
            }
            .to_bytes(),
        )
    }

    /// WideGather (0xDC op 4) of `(dest, bell)` over the cursor, the
    /// transit record of each position given (any account for an absent
    /// slot).
    fn gather(
        &mut self,
        dest: WideCoord,
        bell: u32,
        start: u8,
        n: u8,
        transits: &[AccountInfo<'static>],
    ) -> Result<(), Refused> {
        let region = WideProvince::read(&self.province_data(dest))
            .map(|p| p.region)
            .unwrap_or(0);
        let (_, anchor) = self.stage_seed(bell, region, &BELL_SEED);
        let mut a = vec![
            self.w.payer.clone(),
            self.w.season.clone(),
            with_writable(&self.province(dest), false),
            anchor,
            self.inputs(dest, bell),
            with_writable(&self.day(dest, bell), false),
            self.ix_sysvar(),
            self.w.system.clone(),
        ];
        for j in 0..n as usize {
            let k = start as usize + j;
            let s = self.slot(dest, bell, (k / 4) as u8, (k % 4) as u8);
            a.push(with_writable(&s, false));
            let t = transits
                .get(j)
                .cloned()
                .unwrap_or_else(|| self.w.system.clone());
            a.push(t);
        }
        run_tx(&a, &wix::Gather { bell, start, n }.to_bytes())
    }

    /// WideClose(2) of the slot `(dest, bell, faction, i)` to `rent_to`,
    /// THE anchor of `(bell, region)` listed when `anchor` is set.
    fn close_slot(
        &mut self,
        dest: WideCoord,
        bell: u32,
        faction: u8,
        i: u8,
        rent_to: AccountInfo<'static>,
        anchor: Option<AccountInfo<'static>>,
    ) -> Result<(), Refused> {
        let season = self.w.season.clone();
        self.close_slot_under(dest, bell, faction, i, rent_to, anchor, season)
    }

    /// [`Wide::close_slot`] with the Season position given (the tombstone).
    #[allow(clippy::too_many_arguments)]
    fn close_slot_under(
        &mut self,
        dest: WideCoord,
        bell: u32,
        faction: u8,
        i: u8,
        rent_to: AccountInfo<'static>,
        anchor: Option<AccountInfo<'static>>,
        season: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let mut a = vec![
            wallet(ANYONE, true, false, 0),
            with_writable(&season, false),
            self.slot(dest, bell, faction, i),
            unsigned(&rent_to),
        ];
        if let Some(an) = anchor {
            a.push(an);
        }
        run_tx(
            &a,
            &wix::Close {
                what: wix::CLOSE_WHAT_SLOT,
            }
            .to_bytes(),
        )
    }

    /// WideClose(3) of the day record of `(dest, day_of(bell))` to `rent_to`.
    fn close_day(
        &mut self,
        dest: WideCoord,
        bell: u32,
        rent_to: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&self.w.season, false),
            with_writable(&self.province(dest), false),
            self.day(dest, bell),
            unsigned(&rent_to),
        ];
        run_tx(
            &a,
            &wix::Close {
                what: wix::CLOSE_WHAT_DAY,
            }
            .to_bytes(),
        )
    }

    /// WideClose(4) of the ClashInputs of `(dest, bell)` to `rent_to`.
    fn close_inputs(
        &mut self,
        dest: WideCoord,
        bell: u32,
        rent_to: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&self.w.season, false),
            with_writable(&self.province(dest), false),
            self.inputs(dest, bell),
            unsigned(&rent_to),
        ];
        run_tx(
            &a,
            &wix::Close {
                what: wix::CLOSE_WHAT_INPUTS,
            }
            .to_bytes(),
        )
    }

    /// WideClose(5) of the transit record `(coord, site, slot)` to
    /// `rent_to`, the holding at its canonical address listed (present or
    /// closed).
    fn close_transit(
        &mut self,
        coord: WideCoord,
        site: u8,
        slot: u8,
        rent_to: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&self.w.season, false),
            self.transit(coord, site, slot),
            unsigned(&rent_to),
            self.holding(coord, site),
        ];
        run_tx(
            &a,
            &wix::Close {
                what: wix::CLOSE_WHAT_TRANSIT,
            }
            .to_bytes(),
        )
    }

    /// WideClose(6) of the province `coord` into wedge `wedge`'s fund.
    fn close_province(&mut self, coord: WideCoord, wedge: u8) -> Result<(), Refused> {
        let season = self.w.season.clone();
        self.close_province_under(coord, wedge, season)
    }

    /// [`Wide::close_province`] with the Season position given.
    fn close_province_under(
        &mut self,
        coord: WideCoord,
        wedge: u8,
        season: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&season, false),
            self.province(coord),
            with_writable(&self.w.fund(wedge), true),
        ];
        run_tx(
            &a,
            &wix::Close {
                what: wix::CLOSE_WHAT_PROVINCE,
            }
            .to_bytes(),
        )
    }

    /// [`Wide::close_roster`] with the Season position given (the
    /// tombstone).
    fn close_roster_under(
        &mut self,
        coord: WideCoord,
        rent_to: AccountInfo<'static>,
        season: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&season, false),
            self.roster(coord),
            unsigned(&rent_to),
            with_writable(&self.province(coord), false),
        ];
        run_tx(&a, &wix::CloseRoster.to_bytes())
    }

    /// WideSettleTransit (0xDC op 5) of `host`'s `slot`, sealed to `dest`.
    #[allow(clippy::too_many_arguments)]
    fn settle_transit(
        &mut self,
        host: WideHostRef,
        slot: u8,
        dest: WideCoord,
        arrive: u32,
        faction: u8,
        slot_i: u8,
        commit: [u8; 32],
        seal: [u8; frontier_abi::world_index::seal::WIDE_SEAL_LEN],
        rent_to: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let payer = self.w.payer.clone();
        self.settle_transit_with(
            host, slot, dest, arrive, faction, slot_i, commit, seal, rent_to, payer, None,
        )
    }

    /// [`Wide::settle_transit`] with the settler's beneficiary (the
    /// bad-seal reward's recipient, the instruction's `beneficiary`) and,
    /// when given, the anchor position (else THE anchor of `(arrive,
    /// region of dest)` as staged).
    #[allow(clippy::too_many_arguments)]
    fn settle_transit_with(
        &mut self,
        host: WideHostRef,
        slot: u8,
        dest: WideCoord,
        arrive: u32,
        faction: u8,
        slot_i: u8,
        commit: [u8; 32],
        seal: [u8; frontier_abi::world_index::seal::WIDE_SEAL_LEN],
        rent_to: AccountInfo<'static>,
        beneficiary: AccountInfo<'static>,
        anchor: Option<AccountInfo<'static>>,
    ) -> Result<(), Refused> {
        let payer = self.w.payer.clone();
        self.settle_transit_full(
            host,
            slot,
            dest,
            arrive,
            faction,
            slot_i,
            commit,
            seal,
            rent_to,
            payer.clone(),
            payer,
            beneficiary,
            anchor,
        )
    }

    /// [`Wide::settle_transit_with`] with the slot beneficiary and the
    /// resolver positions given too (the holding's rent payer position
    /// stays the payer, the holdings' rent payer here).
    #[allow(clippy::too_many_arguments)]
    fn settle_transit_full(
        &mut self,
        host: WideHostRef,
        slot: u8,
        dest: WideCoord,
        arrive: u32,
        faction: u8,
        slot_i: u8,
        commit: [u8; 32],
        seal: [u8; frontier_abi::world_index::seal::WIDE_SEAL_LEN],
        rent_to: AccountInfo<'static>,
        slot_ben: AccountInfo<'static>,
        resolver: AccountInfo<'static>,
        beneficiary: AccountInfo<'static>,
        anchor: Option<AccountInfo<'static>>,
    ) -> Result<(), Refused> {
        let coord = host.key().coord();
        let region = WideProvince::read(&self.province_data(dest))
            .map(|p| p.region)
            .unwrap_or(0);
        let anchor = match anchor {
            Some(an) => an,
            None => self.stage_seed(arrive, region, &BELL_SEED).1,
        };
        let payer = self.w.payer.clone();
        let ben_key = *beneficiary.key.as_array();
        let a = [
            payer.clone(),
            self.w.season.clone(),
            self.holding(coord, host.site()),
            self.province(dest),
            self.inputs(dest, arrive),
            self.slot(dest, arrive, faction, slot_i),
            self.province(coord),
            anchor,
            unsigned(&slot_ben),
            unsigned(&resolver),
            unsigned(&payer),
            unsigned(&beneficiary),
            self.transit(coord, host.site(), slot),
            self.roster(coord),
            self.w.system.clone(),
            self.roster(dest),
            unsigned(&rent_to),
        ];
        run_tx(
            &a,
            &wix::SettleTransit {
                transit_slot: slot,
                commit,
                seal,
                beneficiary: ben_key,
            }
            .to_bytes(),
        )
    }

    /// WideCloseRoster (0xDE op 1) of `coord`'s roster to `rent_to`.
    fn close_roster(
        &mut self,
        coord: WideCoord,
        rent_to: AccountInfo<'static>,
    ) -> Result<(), Refused> {
        let a = [
            wallet(ANYONE, true, false, 0),
            with_writable(&self.w.season, false),
            self.roster(coord),
            unsigned(&rent_to),
            with_writable(&self.province(coord), false),
        ];
        run_tx(&a, &wix::CloseRoster.to_bytes())
    }

    /// The roster side table of `coord`, decoded.
    fn roster_record(&mut self, coord: WideCoord) -> WideRoster {
        let ai = self.roster(coord);
        let d = ai.try_borrow_data().unwrap().to_vec();
        WideRoster::read(&d).unwrap()
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

/// The wide records (`PSW1`) of the **successful** transactions since the
/// last call, in order ([`run_tx`] drops a failed transaction's logs).
fn wide_records() -> Vec<Vec<u8>> {
    std::mem::take(&mut *WIDE_LOGS.lock().unwrap())
}

/// The event chain `(seq, head)` of a wide account's header.
fn chain(ai: &AccountInfo<'static>) -> (u64, [u8; 32]) {
    let d = ai.try_borrow_data().unwrap();
    crate::layout::chain_of(&d).unwrap()
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

    // The march gate over the final wide holding, in the deployed Depart's
    // shape (the standing province and the issuing holding's province as
    // distinct positions): the deployed checks, the legacy/wide boundary,
    // then the identity gate; nothing written, nothing debited.
    at_bell(3 + PV::COHORT_BELLS);
    let key = ProvinceKey::new(w.world_id(), coord);
    let host = WideHostRef::new(key, site, 1, 0).unwrap();
    let holding_before = w.holding_data(coord, site);
    let payer_before = w.w.payer.lamports();
    let home = w.province(coord);
    assert_eq!(
        w.depart(&b, host, home.clone(), 40),
        Err(E::NotOwner as u32)
    );
    assert_eq!(
        w.depart(&a, host, home.clone(), 40),
        Err(E::NotResident as u32),
        "the standing province was never resolved past its opening"
    );
    // The boundary: the same host named as standing in a deployed Province
    // of the rim is refused before the resident check that refused above,
    // before the identity gate and before any debit. One quota, one roster
    // and one resolution per destination bell do not span ring 128/129.
    let rim = w.w.province(RIM);
    assert_eq!(
        w.depart(&a, host, rim.clone(), 40),
        Err(E::NotImplemented as u32),
        "a wide host cannot stand in the legacy disk"
    );
    let none = w.w.system.clone();
    assert_eq!(
        w.depart(&a, host, none, 40),
        Err(E::BadAccount as u32),
        "an absent standing province"
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
    // The identity gate comes before the arrival window (the deployed
    // step 3 before step 4): every wide holding is founded under the
    // unallocated identity, so no host of it is in any roster.
    assert_eq!(
        w.depart(&a, host, home.clone(), 1),
        Err(E::NotImplemented as u32)
    );
    assert_eq!(
        w.depart(&a, host, home.clone(), 40),
        Err(E::NotImplemented as u32)
    );
    assert_eq!(
        WideHolding::read(&w.holding_data(coord, site))
            .unwrap()
            .host_identity,
        HOST_IDENTITY_UNALLOCATED
    );
    let alias = frontier_abi::world_index::march::wide_host_alias(&host);
    assert!(
        frontier_abi::world_index::march::is_wide_alias(alias),
        "the roster alias no legacy reader parses"
    );
    assert_eq!(frontier_abi::addr::split_host_id(alias), None);
    {
        let province = w.province(coord);
        let mut pd = province.try_borrow_mut_data().unwrap();
        put(&mut pd, PV::RESOLVED_NEXT, &1u32.to_le_bytes());
    }
    assert_eq!(w.holding_data(coord, site), holding_before);
    assert_eq!(w.w.payer.lamports(), payer_before, "nothing debited");
    assert!(records().is_empty());
}

/// The closed host lifecycle through the envelope, on a final wide
/// holding: an empty province resolved before its first muster (no roster
/// needed), every resolve authenticated against THE anchor of the
/// province's stored region (the bell due, the window closed, the seed
/// posted, no arrival record), the muster's deployed refusals before any
/// write and then the muster (the entry under the alias, the roster side
/// table created from the payer, the reserve debited, the host sequence
/// and the identity allocated), the next bell's resolve settling the
/// pending muster, the dissolve's refusals and the Leave, the next resolve
/// settling it, the return crediting whole troops once (and stranding a
/// host whose holding is not at its generation), Depart still refused
/// under the allocated identity, the NFT act's whitelist and authority,
/// and the season-end close of the roster to its immutable rent recipient.
#[test]
fn wide_land_host_musters_resolves_dissolves_and_returns_through_the_envelope() {
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    let payer = w.w.payer.clone();
    w.fixture_rim_home(&a, &template, 0, 1_500 * MILLI);
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)),
        Ok(())
    );
    assert_eq!(code(w.settle(&a, 0, coord, site, 1, None)), Ok(()));
    at_bell(3);
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    records();
    let key = ProvinceKey::new(w.world_id(), coord);
    let region = WideProvince::read(&w.province_data(coord)).unwrap().region;
    let rent_r = crate::init::rent(wro::wide_roster::SIZE).unwrap();
    // **Fixture**: a reserve of 500 Spearmen and 500 Settlers (the
    // deployed Train is not run here; the Settlers show the kernel's
    // host-unit refusal behind a sufficient reserve).
    {
        let hai = w.holding(coord, site);
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::reserve(0), &500u32.to_le_bytes());
        put(&mut hd, H::reserve(7), &500u32.to_le_bytes());
    }
    // A passable tile that is no site, not the keep's and not the camp's:
    // the hosts stand alone (the bells' clashes have no engagement).
    let pd = w.province_data(coord);
    let passable = Ro(&pd).u64(PV::PASSABLE_MASK).unwrap();
    let keep_tile = read_keep(&pd).unwrap().map(|k| k.tile);
    let camp = Camp::read(&pd).unwrap();
    let camp_tile = camp.present().then_some(camp.tile);
    let n_sites = pd[PV::SITE_COUNT] as usize;
    let sites = &pd[PV::SITES..PV::SITES + n_sites];
    let tile = (1..61u8)
        .find(|t| {
            passable & (1 << t) != 0
                && Some(*t) != keep_tile
                && Some(*t) != camp_tile
                && !sites.contains(t)
        })
        .expect("a passable tile");
    let other = (0..12u8).find(|s| *s != site).unwrap();
    let home = w.province(coord);
    let none = w.w.system.clone();

    // --- Bootstrap: the province was opened at bell 1 and never resolved,
    // so no resident action is possible; the empty province resolves
    // through the real bell model with no roster at all.
    assert_eq!(rd_u32(&pd, PV::RESOLVED_NEXT), 1);
    assert_eq!(
        code(w.muster(&a, WALLET_A, coord, site, 0, 300, tile)),
        Err(E::NotResident as u32),
        "resolved through bell 0 only"
    );
    assert_eq!(code(w.resolve(coord, 2)), Err(E::OutOfOrder as u32));
    assert_eq!(
        code(w.resolve_with(coord, 1, (none.clone(), none.clone()))),
        Err(E::BadAddress as u32),
        "THE anchor of (bell, region) must be named"
    );
    let (cache, anchor) = w.stage_seed(1, region, &BELL_SEED);
    assert_eq!(
        code(w.resolve_with(coord, 1, (none.clone(), anchor.clone()))),
        Err(E::SeedNotReady as u32),
        "the window closed, the seed not posted"
    );
    {
        // a present record at the wide ClashInputs position that is no
        // readable, writable, fully gathered wide ClashInputs is refused,
        // never read as "no arrivals"
        let ik = wa::clash_inputs_address(&w.w.ctx, key, 1);
        let present = info(leak(ik, PROGRAM, vec![7u8; 16], 0, BIG), false, false);
        assert_eq!(
            code(w.resolve_full(coord, 1, (cache.clone(), anchor.clone()), present)),
            Err(E::BadAccount as u32)
        );
    }
    assert!(wide_records().is_empty(), "a refusal logs nothing");
    assert_eq!(code(w.resolve(coord, 1)), Ok(()));
    let pd = w.province_data(coord);
    assert_eq!(rd_u32(&pd, PV::RESOLVED_NEXT), 2);
    assert_eq!(rd_u32(&pd, PV::RESOLVE_SUMMARY + SU::BELL), 1);
    assert_eq!(rd_u32(&pd, PV::RESOLVE_SUMMARY + SU::ENGAGEMENTS), 0);
    assert_eq!(&pd[PV::RESOLVE_SUMMARY + SU::RESOLVER..][..8], &PAYER[..8]);
    assert!(
        absent(&w.roster(coord)),
        "an empty province needs no roster"
    );
    // The wide record of the bell: its own format, keyed by the full
    // province key, the input and output commitments, chained to the
    // province alone (`PSW1`, never a PS2 record).
    let mut trace: Vec<Vec<u8>> = Vec::new();
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Resolve, 1));
        assert_eq!(r.province(), Some(key));
        assert_ne!(&r.payload[..32], &r.payload[32..64], "input ≠ output");
        assert_eq!(&r.payload[64..68], &0u32.to_le_bytes(), "no engagement");
        assert_eq!(r.payload[70], 0, "nothing to settle");
        let link = r.link(WideEntity::Province).unwrap();
        assert_eq!(link.seq, 1);
        assert_eq!(chain(&w.province(coord)), (1, link.head));
        assert_eq!(r.link(WideEntity::Holding), None);
        assert_eq!(
            frontier_abi::log::decode(&wr[0]).err(),
            Some(frontier_abi::log::LogError::Version(
                wev::WIDE_EVENT_VERSION
            )),
            "a deployed reader refuses the version: unknown, never misread"
        );
    }
    trace.extend(wr);
    assert!(records().is_empty(), "no PS2 record of the wide world");
    assert_eq!(
        code(w.resolve(coord, 1)),
        Err(E::OutOfOrder as u32),
        "replay"
    );
    assert_eq!(code(w.resolve(coord, 2)), Ok(()));
    assert_eq!(
        code(w.resolve(coord, 3)),
        Err(E::TooEarly as u32),
        "bell 3's window is open at bell 3"
    );
    assert_eq!(rd_u32(&w.province_data(coord), PV::RESOLVED_NEXT), 3);
    let wr = wide_records();
    assert_eq!(
        wr.len(),
        1,
        "one record per resolved bell, none for a refusal"
    );
    assert_eq!(WideRecord::decode(&wr[0]).unwrap().bell, 2);
    trace.extend(wr);
    assert!(records().is_empty());

    // --- The muster: the deployed refusals, each before any write.
    let holding_before = w.holding_data(coord, site);
    let payer_before = payer.lamports();
    let m = |w: &mut Wide, actor, unit, troops, tile| {
        code(w.muster(&a, actor, coord, site, unit, troops, tile))
    };
    assert_eq!(m(&mut w, WALLET_B, 0, 300, tile), Err(E::Auth as u32));
    assert_eq!(
        m(&mut w, WALLET_A, 7, 300, tile),
        Err(E::BadData as u32),
        "Settler is outside the muster reserve-unit domain"
    );
    assert_eq!(m(&mut w, WALLET_A, 9, 300, tile), Err(E::BadData as u32));
    assert_eq!(
        m(&mut w, WALLET_A, 0, 600, tile),
        Err(E::Insufficient as u32),
        "the reserve"
    );
    assert_eq!(
        m(&mut w, WALLET_A, 3, 100, tile),
        Err(E::Insufficient as u32),
        "an empty reserve of another unit"
    );
    assert_eq!(
        m(&mut w, WALLET_A, 0, 50, tile),
        Err(E::Kernel as u32),
        "below the kernel's minimum"
    );
    assert_eq!(m(&mut w, WALLET_A, 0, 300, 0xFF), Err(E::BadData as u32));
    {
        let rim = w.w.province(RIM);
        let acc = w.muster_accounts(&a, WALLET_A, coord, site, rim);
        let x = wix::Muster {
            unit: 0,
            troops: 300,
            tile,
        };
        assert_eq!(
            code(run_tx(&acc, &x.to_bytes())),
            Err(E::BadAddress as u32),
            "the holding's own wide province, not a deployed one"
        );
    }
    assert_eq!(w.holding_data(coord, site), holding_before);
    assert_eq!(payer.lamports(), payer_before);
    assert!(absent(&w.roster(coord)));
    assert!(records().is_empty());
    assert!(wide_records().is_empty(), "a refusal logs nothing");

    // The muster: the entry under the alias, the roster created from the
    // payer, the reserve, the sequence, the identity, the wide record.
    assert_eq!(m(&mut w, WALLET_A, 0, 300, tile), Ok(()));
    let host = WideHostRef::new(key, site, 1, 0).unwrap();
    let alias = wide_host_alias(&host);
    let pd = w.province_data(coord);
    let e0 = read_entry(&pd, 0).unwrap();
    assert_eq!(
        (
            e0.id,
            e0.state,
            e0.troops,
            e0.tile,
            e0.from_bell,
            e0.faction
        ),
        (alias, EN::STATE_MUSTER_PENDING, 300_000, tile, 4, a.faction)
    );
    assert_eq!(pd[PV::N_ENTRIES], 1);
    let hd = w.holding_data(coord, site);
    assert_eq!(rd_u32(&hd, H::reserve(0)), 200);
    assert_eq!(rd_u32(&hd, H::HOST_SEQ), 1);
    assert_eq!(
        WideHolding::read(&hd).unwrap().host_identity,
        HOST_IDENTITY_FULL_REF_V1,
        "allocated at the first muster"
    );
    let rai = w.roster(coord);
    assert_eq!(*rai.owner, Pubkey::new_from_array(PROGRAM));
    assert_eq!(rai.lamports(), rent_r);
    assert_eq!(payer.lamports(), payer_before - rent_r, "the roster's rent");
    let roster = w.roster_record(coord);
    assert_eq!((roster.rent_to, roster.province), (PAYER, key));
    assert_eq!(
        roster.ref_at(&rai.try_borrow_data().unwrap(), 0).unwrap(),
        Some(host)
    );
    assert!(
        records().is_empty(),
        "no PS2 record: the alias is no host id"
    );
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Muster, 3));
        assert_eq!(r.host(), Some(host), "keyed by the full reference");
        assert_eq!(r.standing(), Some(key), "and the province it happened in");
        assert_eq!(
            r.home_of(),
            Some(key),
            "which is the home here: the path is local"
        );
        assert_eq!(r.province_of(), Some(key));
        assert_eq!(r.payload[0], 0);
        assert_eq!(&r.payload[1..5], &300u32.to_le_bytes());
        assert_eq!((r.payload[5], r.payload[6]), (tile, 0));
        assert_eq!(&r.payload[7..15], &alias.to_le_bytes());
        let lp = r.link(WideEntity::Province).unwrap();
        let lh = r.link(WideEntity::Holding).unwrap();
        assert_eq!(
            (lp.seq, lh.seq),
            (3, 1),
            "after two resolves; the first of the holding"
        );
        assert_eq!(chain(&w.province(coord)), (3, lp.head));
        assert_eq!(chain(&w.holding(coord, site)), (1, lh.head));
    }
    trace.extend(wr);
    // A second host of the holding is the next sequence number; the roster
    // is reused.
    assert_eq!(m(&mut w, WALLET_A, 0, 100, tile), Ok(()));
    let host1 = WideHostRef::new(key, site, 1, 1).unwrap();
    let pd = w.province_data(coord);
    assert_eq!(read_entry(&pd, 1).unwrap().id, wide_host_alias(&host1));
    assert_eq!(rd_u32(&w.holding_data(coord, site), H::HOST_SEQ), 2);
    assert_eq!(rd_u32(&w.holding_data(coord, site), H::reserve(0)), 100);
    assert_eq!(payer.lamports(), payer_before - rent_r, "no second rent");
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    assert_eq!(WideRecord::decode(&wr[0]).unwrap().host(), Some(host1));
    trace.extend(wr);
    // Depart stays refused under the allocated identity: nothing written.
    let hd_after = w.holding_data(coord, site);
    let payer_after = payer.lamports();
    assert!(w.depart(&a, host, home.clone(), 40).is_err());
    assert_eq!(w.holding_data(coord, site), hd_after);
    assert_eq!(payer.lamports(), payer_after);
    assert_eq!(w.province_data(coord), pd);
    assert!(wide_records().is_empty() && records().is_empty());

    // --- Bell 4: the bell's resolve settles the pending musters.
    at_bell(4);
    assert_eq!(code(w.resolve(coord, 3)), Ok(()));
    let pd = w.province_data(coord);
    assert_eq!(read_entry(&pd, 0).unwrap().state, EN::STATE_ROSTER);
    assert_eq!(read_entry(&pd, 1).unwrap().state, EN::STATE_ROSTER);
    assert_eq!(rd_u32(&pd, PV::RESOLVED_NEXT), 4);
    assert_eq!(rd_u32(&pd, PV::RESOLVE_SUMMARY + SU::BELL), 3);
    assert_eq!(pd[PV::N_ENTRIES], 2);
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Resolve, 3));
        assert_eq!(r.payload[70], 1, "the pending musters settled");
        assert_eq!(r.link(WideEntity::Province).unwrap().seq, 5);
    }
    trace.extend(wr);
    // The dissolve: its refusals, then the Leave.
    let gen2 = WideHostRef::new(key, site, 2, 0).unwrap();
    assert_eq!(
        code(w.dissolve(&a, WALLET_A, gen2, home.clone())),
        Err(E::NotOwner as u32)
    );
    assert_eq!(
        code(w.dissolve(&a, WALLET_B, host, home.clone())),
        Err(E::Auth as u32)
    );
    let seq9 = WideHostRef::new(key, site, 1, 9).unwrap();
    assert_eq!(
        code(w.dissolve(&a, WALLET_A, seq9, home.clone())),
        Err(E::NotResident as u32)
    );
    let rim = w.w.province(RIM);
    assert_eq!(
        code(w.dissolve(&a, WALLET_A, host, rim)),
        Err(E::NotImplemented as u32),
        "the legacy/wide boundary"
    );
    let own = w.holding(coord, site);
    assert_eq!(
        code(w.settle_return(coord, own.clone())),
        Err(E::AlreadyDone as u32),
        "nothing departed"
    );
    assert_eq!(code(w.dissolve(&a, WALLET_A, host, home.clone())), Ok(()));
    let pd = w.province_data(coord);
    let e0 = read_entry(&pd, 0).unwrap();
    assert_eq!(
        (e0.op, e0.pend_bell, e0.state),
        (EntryOp::Leave, 4, EN::STATE_ROSTER)
    );
    assert!(records().is_empty());
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Dissolve, 4));
        assert_eq!(r.host(), Some(host));
        assert_eq!(&r.payload[..4], &4u32.to_le_bytes());
        assert_eq!(&r.payload[4..8], &300_000u32.to_le_bytes());
        assert_eq!(r.payload[8], 0);
        assert_eq!(r.link(WideEntity::Province).unwrap().seq, 6);
        assert_eq!(r.link(WideEntity::Holding).unwrap().seq, 3);
    }
    trace.extend(wr);
    assert_eq!(
        code(w.dissolve(&a, WALLET_A, host, home.clone())),
        Err(E::HostBusy as u32)
    );
    assert!(wide_records().is_empty());

    // --- Bell 5: the clash settles the Leave; the return credits the
    // reserve once, by whole troops.
    at_bell(5);
    assert_eq!(code(w.resolve(coord, 4)), Ok(()));
    let pd = w.province_data(coord);
    assert_eq!(read_entry(&pd, 0).unwrap().state, EN::STATE_DEPARTED);
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    assert_eq!(
        WideRecord::decode(&wr[0]).unwrap().payload[70],
        1,
        "the Leave settled"
    );
    trace.extend(wr);
    let foreign = w.holding(coord, other);
    assert_eq!(
        code(w.settle_return(coord, foreign)),
        Err(E::AlreadyDone as u32),
        "no host of that holding departed"
    );
    assert_eq!(code(w.settle_return(coord, own.clone())), Ok(()));
    let pd = w.province_data(coord);
    assert_eq!(
        read_entry(&pd, 0).unwrap(),
        frontier_abi::entry::Entry::FREE
    );
    assert_eq!(pd[PV::N_ENTRIES], 1);
    let rai = w.roster(coord);
    let rd = rai.try_borrow_data().unwrap().to_vec();
    assert_eq!(roster.ref_at(&rd, 0).unwrap(), None);
    assert_eq!(roster.ref_at(&rd, 1).unwrap(), Some(host1));
    assert_eq!(
        rd_u32(&w.holding_data(coord, site), H::reserve(0)),
        400,
        "300 whole troops back, once"
    );
    assert!(records().is_empty());
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Return, 5));
        assert_eq!(r.host(), Some(host));
        assert_eq!(&r.payload[..4], &300_000u32.to_le_bytes(), "credited once");
        assert_eq!((r.payload[4], r.payload[5]), (0, 0));
        assert_eq!(r.link(WideEntity::Province).unwrap().seq, 8);
        assert_eq!(r.link(WideEntity::Holding).unwrap().seq, 4);
    }
    trace.extend(wr);
    assert_eq!(
        code(w.settle_return(coord, own.clone())),
        Err(E::AlreadyDone as u32),
        "no second credit"
    );
    assert!(wide_records().is_empty());
    assert_eq!(rd_u32(&w.holding_data(coord, site), H::reserve(0)), 400);

    // --- A departed host whose holding is not at its generation strands.
    assert_eq!(code(w.dissolve(&a, WALLET_A, host1, home.clone())), Ok(()));
    trace.extend(wide_records());
    at_bell(6);
    assert_eq!(code(w.resolve(coord, 5)), Ok(()));
    trace.extend(wide_records());
    {
        let hai = w.holding(coord, site);
        hai.try_borrow_mut_data().unwrap()[H::GEN] = 2;
    }
    assert_eq!(code(w.settle_return(coord, own.clone())), Ok(()));
    {
        let hai = w.holding(coord, site);
        hai.try_borrow_mut_data().unwrap()[H::GEN] = 1;
    }
    let pd = w.province_data(coord);
    assert_eq!(
        read_entry(&pd, 1).unwrap(),
        frontier_abi::entry::Entry::FREE
    );
    assert_eq!(pd[PV::N_ENTRIES], 0);
    assert_eq!(
        rd_u32(&w.holding_data(coord, site), H::reserve(0)),
        400,
        "stranded: nothing credited"
    );
    assert!(records().is_empty());
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Stranded, 6));
        assert_eq!(r.host(), Some(host1));
        assert_eq!(&r.payload[..4], &100_000u32.to_le_bytes());
        assert_eq!(r.payload[4], 1);
        assert_eq!(r.link(WideEntity::Province).unwrap().seq, 11);
        assert_eq!(
            r.link(WideEntity::Holding),
            None,
            "no credit: no holding link"
        );
    }
    trace.extend(wr);

    // --- The NFT act: a player sub-operation runs under the real resident
    // check; the proof of another Citizen is refused before any write; a
    // class D sub-operation never decodes as an inner.
    let n = w.nft(a.faction, OWNER_A);
    {
        let mut acc = w.muster_accounts(&a, OWNER_A, coord, site, home.clone());
        acc.extend([
            n.policy.clone(),
            n.link.clone(),
            n.asset.clone(),
            n.resident.clone(),
        ]);
        let inner = wix::Muster {
            unit: 0,
            troops: 100,
            tile,
        }
        .to_bytes();
        let mut d = [0u8; 64];
        let len = wix::ResidentAct {
            generation: 0,
            inner: &inner,
        }
        .encode_into(&mut d)
        .unwrap();
        assert!(code(run_tx(&acc, &d[..len])).is_err());
        assert_eq!(rd_u32(&w.holding_data(coord, site), H::HOST_SEQ), 2);
        let inner = wix::Resolve {
            bell: 6,
            beneficiary: PAYER,
        }
        .to_bytes();
        let len = wix::ResidentAct {
            generation: 0,
            inner: &inner,
        }
        .encode_into(&mut d)
        .unwrap();
        assert_eq!(code(run_tx(&acc, &d[..len])), Err(E::BadData as u32));
        assert!(wide_records().is_empty() && records().is_empty());
    }

    // --- Two hosts returning in one transaction, and the transaction that
    // fails between its two records: the holding's chain is set one step
    // below its ceiling, so the first return record advances it and the
    // second cannot; the whole transaction reverts (the runtime's rule, the
    // executor's emulation) and the collector keeps **no** receipt of it.
    assert_eq!(m(&mut w, WALLET_A, 0, 100, tile), Ok(()));
    assert_eq!(m(&mut w, WALLET_A, 0, 100, tile), Ok(()));
    let host2 = WideHostRef::new(key, site, 1, 2).unwrap();
    let host3 = WideHostRef::new(key, site, 1, 3).unwrap();
    assert_eq!(rd_u32(&w.holding_data(coord, site), H::reserve(0)), 200);
    trace.extend(wide_records());
    at_bell(7);
    assert_eq!(code(w.resolve(coord, 6)), Ok(()));
    trace.extend(wide_records());
    assert_eq!(code(w.dissolve(&a, WALLET_A, host2, home.clone())), Ok(()));
    assert_eq!(code(w.dissolve(&a, WALLET_A, host3, home.clone())), Ok(()));
    trace.extend(wide_records());
    at_bell(8);
    assert_eq!(code(w.resolve(coord, 7)), Ok(()));
    trace.extend(wide_records());
    let pd = w.province_data(coord);
    assert_eq!(read_entry(&pd, 0).unwrap().state, EN::STATE_DEPARTED);
    assert_eq!(read_entry(&pd, 1).unwrap().state, EN::STATE_DEPARTED);
    {
        let hai = w.holding(coord, site);
        let hc = chain(&hai);
        {
            let mut hd = hai.try_borrow_mut_data().unwrap();
            put(
                &mut hd,
                frontier_abi::layout::header::EVENT_SEQ,
                &(u64::MAX - 1).to_le_bytes(),
            );
        }
        let before = (
            w.province_data(coord),
            w.holding_data(coord, site),
            w.roster(coord).try_borrow_data().unwrap().to_vec(),
            own.lamports(),
        );
        let e = w.settle_return(coord, own.clone()).err().expect("refused");
        assert_eq!(e.code, E::Overflow as u32, "the second record cannot chain");
        assert!(
            e.wrote,
            "the first record and the credits were written before the refusal"
        );
        assert!(
            wide_records().is_empty(),
            "no receipt of a failed transaction, the first record included"
        );
        assert!(records().is_empty());
        let after = (
            w.province_data(coord),
            w.holding_data(coord, site),
            w.roster(coord).try_borrow_data().unwrap().to_vec(),
            own.lamports(),
        );
        assert_eq!(after, before, "every account as before the transaction");
        assert_eq!(
            rd_u32(&w.holding_data(coord, site), H::reserve(0)),
            200,
            "no credit survives a reverted transaction"
        );
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(
            &mut hd,
            frontier_abi::layout::header::EVENT_SEQ,
            &hc.0.to_le_bytes(),
        );
    }
    // The same return, chained normally: both hosts credited, one record
    // each, in entry order.
    assert_eq!(code(w.settle_return(coord, own.clone())), Ok(()));
    assert_eq!(rd_u32(&w.holding_data(coord, site), H::reserve(0)), 400);
    assert_eq!(w.province_data(coord)[PV::N_ENTRIES], 0);
    let wr = wide_records();
    assert_eq!(wr.len(), 2);
    for (b, h) in wr.iter().zip([host2, host3]) {
        let r = WideRecord::decode(b).unwrap();
        assert_eq!(r.kind, WideKind::Return);
        assert_eq!(r.host(), Some(h));
        assert_eq!(&r.payload[..4], &100_000u32.to_le_bytes());
    }
    trace.extend(wr);
    assert_eq!(
        code(w.settle_return(coord, own.clone())),
        Err(E::AlreadyDone as u32)
    );

    // --- The march stages (0xDC ops 3–5) with no march: each authenticates
    // its records and refuses on the absent transit record (or the empty
    // cursor) with nothing written. The march itself is the next test.
    {
        let pre = (
            w.province_data(coord),
            w.holding_data(coord, site),
            w.roster(coord).try_borrow_data().unwrap().to_vec(),
            payer.lamports(),
        );
        assert_eq!(
            code(w.settle_departure(host, coord, 0)),
            Err(E::TransitState as u32),
            "no march of this slot"
        );
        assert_eq!(
            code(w.gather(coord, 8, 0, 0, &[])),
            Err(E::BadData as u32),
            "an empty cursor"
        );
        let seal = [0x80; frontier_abi::world_index::seal::WIDE_SEAL_LEN];
        assert_eq!(
            code(w.settle_transit(
                host,
                0,
                coord,
                8,
                a.faction,
                0,
                [7; 32],
                seal,
                payer.clone()
            )),
            Err(E::TransitState as u32)
        );
        let post = (
            w.province_data(coord),
            w.holding_data(coord, site),
            w.roster(coord).try_borrow_data().unwrap().to_vec(),
            payer.lamports(),
        );
        assert_eq!(post, pre);
        assert!(wide_records().is_empty() && records().is_empty());
        // a wrong season status is refused before the records
        w.set_status(S::STATUS_ABORTED);
        assert_eq!(
            code(w.settle_departure(host, coord, 0)),
            Err(E::WrongStatus as u32)
        );
        w.set_status(S::STATUS_RUNNING);
    }

    // --- Season end: a pending muster is the season's; the roster closes
    // whole to the payer that created it.
    assert_eq!(m(&mut w, WALLET_A, 0, 100, tile), Ok(()));
    trace.extend(wide_records());
    // The whole trace recomputes both chains to the accounts' headers, each
    // by its full identity: the province's over every record of this
    // province, the holding's over the host records of this holding.
    let bodies: Vec<&[u8]> = trace.iter().map(|b| b.as_slice()).collect();
    assert_eq!(bodies.len(), 20);
    let kinds: Vec<WideKind> = bodies
        .iter()
        .map(|b| WideRecord::decode(b).unwrap().kind)
        .collect();
    assert_eq!(
        kinds,
        [
            WideKind::Resolve,
            WideKind::Resolve,
            WideKind::Muster,
            WideKind::Muster,
            WideKind::Resolve,
            WideKind::Dissolve,
            WideKind::Resolve,
            WideKind::Return,
            WideKind::Dissolve,
            WideKind::Resolve,
            WideKind::Stranded,
            WideKind::Muster,
            WideKind::Muster,
            WideKind::Resolve,
            WideKind::Dissolve,
            WideKind::Dissolve,
            WideKind::Resolve,
            WideKind::Return,
            WideKind::Return,
            WideKind::Muster,
        ]
    );
    let prov_t = wev::WideTarget::Province(key);
    let hold_t = wev::WideTarget::Holding(host.holding_ref());
    assert_eq!(
        wev::verify_chain(prov_t, (0, [0; 32]), bodies.iter().copied()),
        Ok(chain(&w.province(coord)))
    );
    assert_eq!(chain(&w.province(coord)).0, 20);
    assert_eq!(
        wev::verify_chain(hold_t, (0, [0; 32]), bodies.iter().copied()),
        Ok(chain(&w.holding(coord, site)))
    );
    assert_eq!(chain(&w.holding(coord, site)).0, 12);
    // every record is attributed to this province by its full key, and
    // every host record to this holding; another holding or province of
    // this world consumes nothing of the trace
    for b in &bodies {
        let r = WideRecord::decode(b).unwrap();
        assert_eq!(r.province_of(), Some(key));
        assert_eq!(r.holding_of().is_some(), r.kind.host_keyed());
    }
    let other_h = wev::WideTarget::Holding(WideHostRef::new(key, other, 1, 0).unwrap());
    assert_eq!(
        wev::verify_chain(other_h, (0, [0; 32]), bodies.iter().copied()),
        Ok((0, [0; 32]))
    );
    let other_p = wev::WideTarget::Province(ProvinceKey::new(w.world_id(), c(130, 0)));
    assert_eq!(
        wev::verify_chain(other_p, (0, [0; 32]), bodies.iter().copied()),
        Ok((0, [0; 32]))
    );
    // one credit record per returned host, each the amount the reserve took
    let credits: Vec<u32> = bodies
        .iter()
        .map(|b| WideRecord::decode(b).unwrap())
        .filter(|r| r.kind == WideKind::Return)
        .map(|r| u32::from_le_bytes(r.payload[..4].try_into().unwrap()))
        .collect();
    assert_eq!(credits, [300_000, 100_000, 100_000]);
    let payer2 = w.wallet_of(PAYER2);
    w.set_status(S::STATUS_ENDED);
    let end = GENESIS + 200_000i64 * 600 + crate::proc::map::END_GRACE_SECS;
    crate::prologue::set_test_clock(end - 1, 5_000);
    assert_eq!(
        code(w.close_roster(coord, payer.clone())),
        Err(E::TooEarly as u32)
    );
    assert_eq!(
        m(&mut w, WALLET_A, 0, 100, tile),
        Err(E::WrongStatus as u32),
        "no muster after the season"
    );
    crate::prologue::set_test_clock(end, 5_001);
    assert_eq!(
        code(w.close_roster(coord, payer2.clone())),
        Err(E::BadAddress as u32),
        "the immutable rent recipient"
    );
    assert!(wide_records().is_empty(), "refusals log nothing");
    // At the deadline the table closes over the pending muster and the
    // bells of the season the province never resolved, as the deployed
    // CloseProvince closes its entry table: the hosts' rights expired with
    // the deadline (the deployed expiry rule); whole to the payer that
    // created it, nothing credited.
    let payer_before = payer.lamports();
    assert_eq!(code(w.close_roster(coord, payer.clone())), Ok(()));
    assert!(absent(&w.roster(coord)));
    assert_eq!(payer.lamports(), payer_before + rent_r);
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!(r.kind, WideKind::RosterClosed);
        assert_eq!(r.province(), Some(key));
        assert_eq!(&r.payload[..32], &PAYER);
        assert_eq!(&r.payload[32..40], &rent_r.to_le_bytes());
        assert_eq!(r.links, [None, None], "the account is gone: no chain");
    }
    assert_eq!(
        code(w.close_roster(coord, payer.clone())),
        Err(E::BadAccount as u32),
        "closed"
    );
    assert!(
        records().is_empty(),
        "no PS2 record of the wide lifecycle at all"
    );
    assert!(wide_records().is_empty());
}

/// The shortest passable route from `origin_tile` of `from` into `to`
/// over the two provinces' passable masks (a breadth-first search over
/// `WideTile::neighbors`, the wide walk's own adjacency): the destination
/// tile reached, the step directions, and the provinces other than `to`
/// a step enters, in first-entered order (what the reveal must list).
fn march_route(
    w: &mut Wide,
    from: WideCoord,
    to: WideCoord,
    origin_tile: u8,
) -> (u8, Vec<u8>, Vec<WideCoord>) {
    use frontier_abi::world_index::tiles::{TileAddress, WideTile};
    use std::collections::{HashSet, VecDeque};
    let world = w.world_id();
    let pa = Ro(&w.province_data(from)).u64(PV::PASSABLE_MASK).unwrap();
    let pdb = w.province_data(to);
    let pb = Ro(&pdb).u64(PV::PASSABLE_MASK).unwrap();
    // The walk may cross the destination's keep, camp and site tiles but
    // must not **end** on one: the arrival would engage a garrison and the
    // test's fates would depend on the clash.
    let mut avoid = 0u64;
    if let Some(k) = read_keep(&pdb).unwrap() {
        avoid |= 1u64 << k.tile;
    }
    let camp = Camp::read(&pdb).unwrap();
    if camp.present() {
        avoid |= 1u64 << camp.tile;
    }
    let n_sites = pdb[PV::SITE_COUNT] as usize;
    for &s in &pdb[PV::SITES..PV::SITES + n_sites] {
        avoid |= 1u64 << s;
    }
    let start = WideTile::of(TileAddress::new(ProvinceKey::new(world, from), origin_tile).unwrap());
    let mut queue = VecDeque::new();
    let mut prev: HashMap<(i128, i128), (WideTile, u8)> = HashMap::new();
    let mut seen = HashSet::new();
    seen.insert((start.q(), start.r()));
    queue.push_back(start);
    let mut found: Option<WideTile> = None;
    while let Some(t) = queue.pop_front() {
        if t.province_coord() == to && avoid & (1u64 << t.local()) == 0 {
            found = Some(t);
            break;
        }
        for (d, n) in t.neighbors().iter().enumerate() {
            let Some(n) = n else { continue };
            let k = n.province_coord();
            let mask = if k == from {
                pa
            } else if k == to {
                pb
            } else {
                continue;
            };
            if mask & (1u64 << n.local()) == 0 {
                continue;
            }
            if seen.insert((n.q(), n.r())) {
                prev.insert((n.q(), n.r()), (t, d as u8));
                queue.push_back(*n);
            }
        }
    }
    let end = found.expect("a passable route between the neighbours");
    let mut dirs = Vec::new();
    let mut cur = end;
    while (cur.q(), cur.r()) != (start.q(), start.r()) {
        let (p, d) = prev[&(cur.q(), cur.r())];
        dirs.push(d);
        cur = p;
    }
    dirs.reverse();
    // the provinces a step enters, other than the destination
    let mut entered: Vec<WideCoord> = Vec::new();
    let mut t = start;
    for &d in &dirs {
        t = t.neighbors()[d as usize].unwrap();
        let k = t.province_coord();
        if k != to && !entered.contains(&k) {
            entered.push(k);
        }
    }
    (end.local(), dirs, entered)
}

/// The march between two wide provinces through the real dispatcher, over
/// a departure the test stages **exactly as WideDepart would write it**
/// (the debit gate keeps WideDepart's effects refused until the closed
/// flow passes native review; every WideDepart check up to that gate is
/// shown passing first, and the full-slot proof in front of it). Then the
/// stages as written: the origin's SettleDeparture (its refusals, the
/// entry freed, the record stepped); the Reveal at the destination (the
/// commitment, the slot moved, the slot with its bound transit slot, the
/// ArrivalDay created with the bell's bit, the record); the arrival
/// evidence refusing a resolve of the bell without the gathered record;
/// the Gather refusing a sibling transit address and then recording the
/// arrival, stamping the record; the Resolve over the gathered record
/// (the arrival stays, the destination's roster **created** from the fee
/// payer); the SettleTransit's pre-judgement refusals and its closed
/// failure at the chain's BLS syscall on the host (an instruction error,
/// nothing written); the foreign dissolve and return of the host that
/// stayed (the capture lock read in the holding's own province); and the
/// season-end close refusing a holding with an unsettled march. Every
/// record decodes and both provinces' and the holding's chains recompute.
#[test]
fn wide_land_march_stages_settle_a_staged_departure_up_to_the_crypto_gate() {
    use frontier_abi::world_index::march::{MarchState, WideTransit, WIDE_TRANSIT_LEN};
    use frontier_abi::world_index::seal as wseal;
    use frontier_abi::world_index::tiles::TileAddress;
    use permutation_rules::frontier::doctrine::of_faction_v3;
    use permutation_rules::frontier::seal as ks;
    use permutation_rules::frontier::stance::{Posture, Stance};
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    let payer = w.w.payer.clone();
    let dest = c(129, -1);
    assert_eq!(
        w.open_province(129, -1),
        Ok(()),
        "the neighbour on the same ring"
    );
    w.fixture_rim_home(&a, &template, 0, 1_500 * MILLI);
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)),
        Ok(())
    );
    assert_eq!(code(w.settle(&a, 0, coord, site, 1, None)), Ok(()));
    at_bell(3);
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    records();
    let key = ProvinceKey::new(w.world_id(), coord);
    let dkey = ProvinceKey::new(w.world_id(), dest);
    {
        let hai = w.holding(coord, site);
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::reserve(0), &500u32.to_le_bytes());
    }
    let tile = {
        let pd = w.province_data(coord);
        let passable = Ro(&pd).u64(PV::PASSABLE_MASK).unwrap();
        let keep_tile = read_keep(&pd).unwrap().map(|k| k.tile);
        let camp = Camp::read(&pd).unwrap();
        let camp_tile = camp.present().then_some(camp.tile);
        let n_sites = pd[PV::SITE_COUNT] as usize;
        let sites = pd[PV::SITES..PV::SITES + n_sites].to_vec();
        (1..61u8)
            .find(|t| {
                passable & (1 << t) != 0
                    && Some(*t) != keep_tile
                    && Some(*t) != camp_tile
                    && !sites.contains(t)
            })
            .expect("a passable tile")
    };
    let mut trace: Vec<Vec<u8>> = Vec::new();
    for b in 1..=2 {
        assert_eq!(code(w.resolve(coord, b)), Ok(()));
        assert_eq!(code(w.resolve(dest, b)), Ok(()));
    }
    trace.extend(wide_records());
    assert_eq!(
        code(w.muster(&a, WALLET_A, coord, site, 0, 300, tile)),
        Ok(())
    );
    trace.extend(wide_records());
    let host = WideHostRef::new(key, site, 1, 0).unwrap();
    at_bell(4);
    assert_eq!(code(w.resolve(coord, 3)), Ok(()));
    assert_eq!(code(w.resolve(dest, 3)), Ok(()));
    trace.extend(wide_records());
    let pd = w.province_data(coord);
    assert_eq!(read_entry(&pd, 0).unwrap().state, EN::STATE_ROSTER);

    // --- The sealed march: a route the wide walk accepts, the wide
    // plaintext, its commitment and a syntactically valid seal (the host
    // never opens one: nothing here claims a proof).
    let arrive = 20u32;
    let (dest_tile, dirs, via) = march_route(&mut w, coord, dest, tile);
    assert!(!dirs.is_empty() && dirs.len() <= 32);
    let (path_len, path) = ks::encode_path(&dirs).unwrap();
    let plain = wseal::WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: arrive,
        dest: dkey,
        dest_tile,
        stance: 0,
        retreat_bps: 0,
        path_len,
        path,
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    assert_eq!(wseal::validate(&plain, &host, arrive), Ok(()));
    let plain_bytes = wseal::pack(&plain);
    let salt = [0x5a; 32];
    let mut seal = [0x11u8; wseal::WIDE_SEAL_LEN];
    seal[0] = 0x80;
    let commit = wseal::commit(&plain_bytes, &salt);
    let ct_hash = wseal::ct_hash(&seal);
    let seal_root = wseal::seal_root(&commit, &ct_hash);
    let tip = w.min_tip();
    let home = w.province(coord);
    let roster_a = w.roster(coord);

    // --- WideDepart: every check passes and the debit gate refuses before
    // any effect (nothing written, nothing debited, no record).
    let pre = (
        w.province_data(coord),
        w.holding_data(coord, site),
        payer.lamports(),
        w.w.citizen_data(&a),
    );
    assert_eq!(
        code(w.depart_with(
            &a,
            host,
            home.clone(),
            roster_a.clone(),
            0,
            arrive,
            commit,
            seal
        )),
        Err(E::NotImplemented as u32),
        "the debit gate, after every check"
    );
    assert_eq!(
        code(w.depart_with(
            &a,
            host,
            home.clone(),
            roster_a.clone(),
            0,
            100,
            commit,
            seal
        )),
        Err(E::ArrivalBell as u32),
        "the window is checked before the gate"
    );
    assert!(absent(&w.transit(coord, site, 0)));
    assert_eq!(
        (
            w.province_data(coord),
            w.holding_data(coord, site),
            payer.lamports(),
            w.w.citizen_data(&a)
        ),
        pre
    );
    assert!(wide_records().is_empty() && records().is_empty());

    // --- The departure as WideDepart would write it (**fixture**): the
    // transit record of slot 0 from the payer, the entry's Spend, the escrow
    // and the open count in the holding.
    let dealt = of_faction_v3(a.faction)
        .unwrap()
        .dealt_bps(Posture::Stance(Stance::Hold), true) as u16;
    let staged = WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        host,
        0,
        a.faction,
        TileAddress::new(key, tile).unwrap(),
        4,
        arrive,
        GENESIS + 600 * 4,
        300_000,
        crate::proc::host::DEPART_STAMINA,
        dealt,
        seal_root,
        tip,
        crate::layout::transit::FLAG_FEE_ESCROWED | crate::layout::transit::FLAG_BOND_ESCROWED,
        PAYER,
    )
    .unwrap();
    let rent_t = crate::init::rent(WIDE_TRANSIT_LEN).unwrap();
    let transit0 = w.transit(coord, site, 0);
    restore(
        &transit0,
        rent_t,
        &staged.to_bytes(),
        Pubkey::new_from_array(PROGRAM),
    );
    // The full-slot proof: with slot 0 open for this host, a departure
    // under slot 1 is refused before the gate, and slot 0 is in use.
    assert_eq!(
        code(w.depart_with(
            &a,
            host,
            home.clone(),
            roster_a.clone(),
            1,
            arrive,
            commit,
            seal
        )),
        Err(E::HostInTransit as u32)
    );
    assert_eq!(
        code(w.depart_with(
            &a,
            host,
            home.clone(),
            roster_a.clone(),
            0,
            arrive,
            commit,
            seal
        )),
        Err(E::TransitState as u32)
    );
    {
        let pa = w.province(coord);
        let mut pd = pa.try_borrow_mut_data().unwrap();
        let mut e = read_entry(&pd, 0).unwrap();
        let mut kh = e.to_host().unwrap();
        kh.depart(4, crate::proc::host::DEPART_STAMINA, 4).unwrap();
        e.set_host(&kh);
        write_entry(&mut pd, 0, &e).unwrap();
        assert!(matches!(e.op, EntryOp::Spend { .. }));
    }
    {
        let hai = w.holding(coord, site);
        **hai.try_borrow_mut_lamports().unwrap() += tip;
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::ESCROW, &tip.to_le_bytes());
        hd[wh::wide_holding::OPEN_TRANSITS] = 1;
    }
    assert_eq!(
        WideHolding::read(&w.holding_data(coord, site))
            .unwrap()
            .open_transits,
        1
    );
    // Regression: the season ends before the departure bell resolves.
    // Before the deadline (Ended, `end + 72 h` not reached) no season-end
    // close runs: not the roster over the pending `Spend`, not the holding
    // under the escrow, not the transit record; while the Season runs the
    // transit close is refused before anything is read. (At the deadline
    // every one of them closes — the deployed expiry rule — which the
    // season-end test exercises.)
    assert_eq!(
        code(w.close_transit(coord, site, 0, payer.clone())),
        Err(E::WrongStatus as u32),
        "no transit close while the Season runs"
    );
    {
        w.set_status(S::STATUS_ENDED);
        let end = GENESIS + 200_000i64 * 600 + crate::proc::map::END_GRACE_SECS;
        crate::prologue::set_test_clock(end - 1, 8_000);
        assert_eq!(
            code(w.close_roster(coord, payer.clone())),
            Err(E::TooEarly as u32),
            "a departure whose bell is unresolved: nothing closes before the deadline"
        );
        assert_eq!(
            code(w.close_holding(coord, site, payer.clone())),
            Err(E::TooEarly as u32)
        );
        assert_eq!(
            code(w.close_transit(coord, site, 0, payer.clone())),
            Err(E::TooEarly as u32)
        );
        assert!(!absent(&w.roster(coord)) && !absent(&w.holding(coord, site)));
        w.set_status(S::STATUS_RUNNING);
    }

    // --- Bell 5: the origin settles the departure after resolving bell 4.
    at_bell(5);
    assert_eq!(
        code(w.settle_departure(host, coord, 0)),
        Err(E::TooEarly as u32),
        "the departure bell is not resolved"
    );
    assert_eq!(code(w.resolve(coord, 4)), Ok(()));
    trace.extend(wide_records());
    let pd = w.province_data(coord);
    assert_eq!(read_entry(&pd, 0).unwrap().state, EN::STATE_DEPARTED);
    let other = WideHostRef::new(key, site, 1, 9).unwrap();
    assert_eq!(
        code(w.settle_departure(other, coord, 0)),
        Err(E::BadAccount as u32),
        "not the record's host"
    );
    assert_eq!(code(w.settle_departure(host, coord, 0)), Ok(()));
    let pd = w.province_data(coord);
    assert_eq!(
        read_entry(&pd, 0).unwrap(),
        frontier_abi::entry::Entry::FREE
    );
    assert_eq!(pd[PV::N_ENTRIES], 0);
    assert_eq!(
        w.roster_record(coord)
            .ref_at(&roster_a.try_borrow_data().unwrap(), 0)
            .unwrap(),
        None,
        "the reference released"
    );
    let t = WideTransit::from_bytes(&transit0.try_borrow_data().unwrap()).unwrap();
    assert_eq!(t.state, MarchState::Settled);
    assert_eq!((t.troops_after, t.stamina_after), (300_000, 46));
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::DepartureSettled, 5));
        assert_eq!((r.host(), r.standing()), (Some(host), Some(key)));
        assert_eq!(&r.payload[..2], &[0, 0], "slot 0, not destroyed");
        assert_eq!(&r.payload[2..6], &300_000u32.to_le_bytes());
        assert_eq!(&r.payload[6..8], &46u16.to_le_bytes());
        assert_eq!(r.payload[10], 0, "entry 0");
        assert!(r.link(WideEntity::Province).is_some() && r.link(WideEntity::Holding).is_some());
    }
    trace.extend(wr);
    assert_eq!(
        code(w.settle_departure(host, coord, 0)),
        Err(E::AlreadyDone as u32)
    );

    // --- The reveal at the destination (the window of bell 20 is open):
    // the commitment, the slot moved, then the slot and the day.
    assert_eq!(
        code(w.reveal(
            host,
            0,
            dest,
            arrive,
            0,
            plain_bytes,
            [0x5b; 32],
            ct_hash,
            &via
        )),
        Err(E::CommitMismatch as u32)
    );
    assert_eq!(
        code(w.reveal(host, 0, dest, arrive, 1, plain_bytes, salt, ct_hash, &via)),
        Err(E::SlotMoved as u32)
    );
    assert!(absent(&w.day(dest, arrive)) && absent(&w.slot(dest, arrive, a.faction, 0)));
    let payer_before = payer.lamports();
    assert_eq!(
        code(w.reveal(host, 0, dest, arrive, 0, plain_bytes, salt, ct_hash, &via)),
        Ok(())
    );
    let rent_s = crate::init::rent(wa::wide_arrival_slot::SIZE).unwrap();
    let rent_d = crate::init::rent(wa::wide_arrival_day::SIZE).unwrap();
    assert_eq!(payer.lamports(), payer_before - rent_s - rent_d);
    let slot0 = w.slot(dest, arrive, a.faction, 0);
    let s = wa::WideArrivalSlot::read(&slot0.try_borrow_data().unwrap()).unwrap();
    assert_eq!(
        (s.host, s.transit_slot, s.dest, s.bell, s.faction, s.i),
        (host, 0, dkey, arrive, a.faction, 0)
    );
    assert_eq!(
        (s.rent_to, s.citizen, s.dep_mass, s.tile),
        (PAYER, a.key, 300_000, dest_tile)
    );
    assert_eq!(s.flags, wa::wide_arrival_slot::FLAG_CREATED_DAY);
    assert_eq!(s.ev_slot, 1_000 + 5, "the landing slot of the clock");
    let day = w.day(dest, arrive);
    let d = wa::WideArrivalDay::read(&day.try_borrow_data().unwrap()).unwrap();
    assert!(d.has(arrive) && !d.has(arrive - 1));
    assert_eq!((d.rent_to, d.dest, d.day), (PAYER, dkey, 0));
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::Revealed, 5));
        assert_eq!(
            (r.host(), r.standing(), r.home_of()),
            (Some(host), Some(dkey), Some(key))
        );
        assert_eq!(r.province_of(), Some(dkey), "attributed where it happened");
        assert_eq!(&r.payload[..5], &[0, a.faction, 0, dest_tile, 0]);
        assert_eq!(&r.payload[7..11], &300_000u32.to_le_bytes());
        assert_eq!(r.payload[11], 0, "nothing displaced");
        assert_eq!(r.links, [None, None], "nothing chained is written");
    }
    trace.extend(wr);
    assert_eq!(
        code(w.reveal(host, 0, dest, arrive, 0, plain_bytes, salt, ct_hash, &via)),
        Err(E::AlreadyDone as u32),
        "already in the quota"
    );

    // --- Bell 21: the destination resolves through bell 19; bell 20 has
    // arrivals (the day's bit), so without the gathered record it refuses.
    at_bell(21);
    for b in 4..arrive {
        assert_eq!(code(w.resolve(dest, b)), Ok(()), "bell {b}");
    }
    trace.extend(wide_records());
    assert_eq!(
        code(w.resolve(dest, arrive)),
        Err(E::NotGathered as u32),
        "the arrival evidence: a reveal exists, the gather does not"
    );
    // The gather binds the slot to its transit slot: the sibling record's
    // address is refused; then the arrival is recorded and the record
    // stamped.
    let k = wa::wide_clash_inputs::position(a.faction, 0);
    let mut ts = vec![w.w.system.clone(); 24];
    ts[k] = w.transit(coord, site, 1);
    assert_eq!(
        code(w.gather(dest, arrive, 0, 24, &ts)),
        Err(E::BadAddress as u32),
        "slot 1 is not the slot the arrival is bound to"
    );
    ts[k] = w.transit(coord, site, 0);
    assert_eq!(code(w.gather(dest, arrive, 0, 24, &ts)), Ok(()));
    let inputs = w.inputs(dest, arrive);
    let cd = inputs.try_borrow_data().unwrap().to_vec();
    let ih = wa::WideClashInputsHdr::read(&cd).unwrap();
    assert_eq!(
        (ih.arrivals_mask, ih.n_present, ih.flags, ih.rent_to),
        (wa::wide_clash_inputs::ALL_GATHERED, 1, 0, PAYER)
    );
    let arr = wa::WideArrival::read_at(&cd, k).unwrap().unwrap();
    assert_eq!(
        (arr.host, arr.present, arr.troops, arr.stamina),
        (host, true, 300_000, 61)
    );
    let t = WideTransit::from_bytes(&transit0.try_borrow_data().unwrap()).unwrap();
    assert_eq!((t.state, t.dest), (MarchState::Gathered, Some(dkey)));
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.province()), (WideKind::Gathered, Some(dkey)));
        assert_eq!(&r.payload[..4], &arrive.to_le_bytes());
        assert_eq!((r.payload[4], r.payload[5]), (0, 24));
        assert_eq!(
            &r.payload[6..10],
            &wa::wide_clash_inputs::ALL_GATHERED.to_le_bytes()
        );
        assert_eq!((r.payload[10], r.payload[11]), (1, 0));
    }
    trace.extend(wr);
    // The resolve over the gathered record: the arrival stays, the
    // destination's roster is created from the fee payer.
    assert!(absent(&w.roster(dest)), "no host ever stood here");
    let payer_before = payer.lamports();
    assert_eq!(code(w.resolve_gathered(dest, arrive)), Ok(()));
    let rent_r = crate::init::rent(wro::wide_roster::SIZE).unwrap();
    assert_eq!(payer.lamports(), payer_before - rent_r, "the roster's rent");
    let rb = w.roster_record(dest);
    assert_eq!((rb.rent_to, rb.province), (PAYER, dkey));
    let pdb = w.province_data(dest);
    let i_b = (0..PV::ENTRIES_N)
        .find(|&i| read_entry(&pdb, i).unwrap().id == wide_host_alias(&host))
        .expect("the arrival's entry");
    let eb = read_entry(&pdb, i_b).unwrap();
    assert_eq!(
        (eb.state, eb.troops, eb.from_bell),
        (EN::STATE_ROSTER, 300_000, arrive + 1)
    );
    assert_eq!(
        rb.ref_at(&w.roster(dest).try_borrow_data().unwrap(), i_b)
            .unwrap(),
        Some(host),
        "paired by full reference"
    );
    assert_eq!(pdb[PV::RESOLVE_SUMMARY + SU::ARRIVALS], 1);
    let cd = inputs.try_borrow_data().unwrap().to_vec();
    let ih = wa::WideClashInputsHdr::read(&cd).unwrap();
    assert_eq!(
        ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED,
        wa::wide_clash_inputs::FLAG_RESOLVED
    );
    assert_eq!(ih.resolver, PAYER);
    assert_eq!(
        wa::WideArrival::read_at(&cd, k).unwrap().unwrap().fate,
        wa::wide_arrival::FATE_STAYS
    );
    trace.extend(wide_records());

    // --- The settlement: its pre-judgement refusals, then the proof. Its
    // first step decompresses THE anchor's round signature (the chain's,
    // not the seal's): that syscall is a fail-closed stub on the host, so
    // the settlement is refused as an instruction error here and nothing
    // is written; the opener after it, where a bad seal's own points earn
    // a verdict, is never reached on the host.
    assert_eq!(
        code(w.settle_transit(
            host,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit,
            seal,
            payer.clone()
        )),
        Err(E::TooEarly as u32),
        "600 s after the close"
    );
    at_bell(22);
    assert_eq!(
        code(w.settle_transit(
            host,
            0,
            dest,
            arrive,
            a.faction,
            0,
            [8; 32],
            seal,
            payer.clone()
        )),
        Err(E::CommitMismatch as u32)
    );
    // (Under the opt-in native adapter the same refusal stands for the
    // same reason: the staged anchor's `sig48` is all zero, which is not a
    // compressed G1 encoding; the native test stages a real one.)
    assert_eq!(
        code(w.settle_transit(
            host,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit,
            seal,
            payer.clone()
        )),
        Err(E::Crypto as u32),
        "the host cannot decompress the round signature: refused, no verdict"
    );
    assert_eq!(
        WideHolding::read(&w.holding_data(coord, site))
            .unwrap()
            .open_transits,
        1
    );
    assert_eq!(
        Ro(&w.holding_data(coord, site)).u64(H::ESCROW).unwrap(),
        tip
    );
    assert!(wide_records().is_empty() && records().is_empty());

    // --- While the march is open, the host that stayed cannot leave the
    // destination (the deployed `host_in_transit` over the wide records:
    // its entry there is what a bad seal's settlement forfeits), and the
    // season-end close of its holding refuses under the escrow.
    let standing = w.province(dest);
    let roster_b = w.roster(dest);
    let pre = (
        w.province_data(dest),
        w.holding_data(coord, site),
        roster_b.try_borrow_data().unwrap().to_vec(),
        w.w.citizen_data(&a),
    );
    assert_eq!(
        code(w.dissolve_at(&a, WALLET_A, host, standing.clone(), roster_b.clone())),
        Err(E::HostInTransit as u32),
        "an open march: no Leave that would escape the forfeit"
    );
    assert_eq!(
        (
            w.province_data(dest),
            w.holding_data(coord, site),
            roster_b.try_borrow_data().unwrap().to_vec(),
            w.w.citizen_data(&a)
        ),
        pre
    );
    let end = GENESIS + 200_000i64 * 600 + crate::proc::map::END_GRACE_SECS;
    at_bell(22);
    assert!(wide_records().is_empty() && records().is_empty());

    // --- The march settled (**fixture**: the bytes a Stays settlement
    // leaves — the record closed to its rent recipient, the escrow paid
    // out, the open count down; the host cannot produce them, the proof
    // being the chain's). Now the host that stayed dissolves in the foreign
    // province (the capture lock read in its holding's own province) and
    // returns to its holding from there.
    restore(&transit0, 0, &[], Pubkey::new_from_array(SYSTEM));
    {
        let hai = w.holding(coord, site);
        **hai.try_borrow_mut_lamports().unwrap() -= tip;
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::ESCROW, &0u64.to_le_bytes());
        hd[wh::wide_holding::OPEN_TRANSITS] = 0;
    }
    assert!(absent(&w.transit(coord, site, 0)));
    assert_eq!(
        code(w.dissolve_at(&a, WALLET_A, host, standing.clone(), roster_b.clone())),
        Ok(())
    );
    let eb = read_entry(&w.province_data(dest), i_b).unwrap();
    assert_eq!((eb.op, eb.pend_bell), (EntryOp::Leave, 22));
    trace.extend(wide_records());
    at_bell(23);
    assert_eq!(code(w.resolve(dest, 21)), Ok(()));
    assert_eq!(code(w.resolve(dest, 22)), Ok(()));
    trace.extend(wide_records());
    assert_eq!(
        read_entry(&w.province_data(dest), i_b).unwrap().state,
        EN::STATE_DEPARTED
    );
    // A departed entry's reference is in the table: before the deadline
    // the table does not close (at the deadline it does, as the deployed
    // Province closes its entries; the return below runs while it stands).
    w.set_status(S::STATUS_ENDED);
    crate::prologue::set_test_clock(end - 1, 9_001);
    assert_eq!(
        code(w.close_roster(dest, payer.clone())),
        Err(E::TooEarly as u32),
        "a departed entry's reference: no close before the deadline"
    );
    w.set_status(S::STATUS_RUNNING);
    at_bell(23);
    let own = w.holding(coord, site);
    let own_province = w.province(coord);
    assert_eq!(
        code(w.settle_return_from(dest, own.clone(), None)),
        Err(E::BadAccount as u32),
        "a foreign return names the holding's own province"
    );
    assert_eq!(
        code(w.settle_return_from(dest, own.clone(), Some(own_province.clone()))),
        Ok(())
    );
    assert_eq!(
        rd_u32(&w.holding_data(coord, site), H::reserve(0)),
        500,
        "200 + 300 back"
    );
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!(r.kind, WideKind::Return);
        assert_eq!((r.standing(), r.home_of()), (Some(dkey), Some(key)));
        assert_eq!(&r.payload[..4], &300_000u32.to_le_bytes());
    }
    trace.extend(wr);
    assert_eq!(
        code(w.settle_return_from(dest, own.clone(), Some(own_province.clone()))),
        Err(E::AlreadyDone as u32)
    );

    // --- Every record attributed by full key; both provinces' and the
    // holding's chains recompute from the trace.
    let bodies: Vec<&[u8]> = trace.iter().map(|b| b.as_slice()).collect();
    for b in &bodies {
        let r = WideRecord::decode(b).unwrap();
        assert!(r.province_of() == Some(key) || r.province_of() == Some(dkey));
    }
    assert_eq!(
        wev::verify_chain(
            wev::WideTarget::Province(key),
            (0, [0; 32]),
            bodies.iter().copied()
        ),
        Ok(chain(&w.province(coord)))
    );
    assert_eq!(
        wev::verify_chain(
            wev::WideTarget::Province(dkey),
            (0, [0; 32]),
            bodies.iter().copied()
        ),
        Ok(chain(&w.province(dest)))
    );
    assert_eq!(
        wev::verify_chain(
            wev::WideTarget::Holding(host.holding_ref()),
            (0, [0; 32]),
            bodies.iter().copied()
        ),
        Ok(chain(&w.holding(coord, site)))
    );

    // --- Season end: with nothing departed, the destination's roster
    // closes whole to the payer that created it at the arrival's resolve.
    w.set_status(S::STATUS_ENDED);
    crate::prologue::set_test_clock(end, 9_002);
    let payer_before = payer.lamports();
    assert_eq!(code(w.close_roster(dest, payer.clone())), Ok(()));
    assert!(absent(&w.roster(dest)));
    assert_eq!(
        payer.lamports(),
        payer_before + crate::init::rent(wro::wide_roster::SIZE).unwrap()
    );
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    assert_eq!(
        WideRecord::decode(&wr[0]).unwrap().kind,
        WideKind::RosterClosed
    );
    assert!(records().is_empty());
}

/// **Opt-in native crypto** (`--features native-crypto-tests`, not the
/// `test-beacon` key): the real SIMD-0388 math behind `crypto::sys` (the
/// adapter of `crypto::native_tests`, which never substitutes a verdict),
/// so the dispatcher settles wide marches whose seals are **real** tlock
/// seals under a **consistent beacon**:
///
/// * **The clock.** The Season's genesis is 1790459175 (quicknet's drand
///   genesis and 3-second period are the harness Season's already): with
///   600-second bells the end of bell 20 is 1790471775, the time of
///   quicknet round 32556137, so `T(20)` is exactly that round. The seal
///   vector `valid_q3` carries that round's **public** signature; it is
///   verified here against the **production** quicknet key with hints
///   constructed from the field (`crypto::quick::tests::hints_for_round`,
///   verification only: nothing is signed) before it is staged. Every
///   time helper reads the Season's genesis (`Wide::at`, `beacon_rounds`);
///   the default tests keep their old genesis.
/// * **THE anchor of bell 20** carries round `T(20)`, an `A` after the
///   bell's end (`round_time(T) + 30`) and that signature (the T model,
///   [`Wide::beacon_rounds`]); the SeedCache carries `S(20, A)` and the
///   literal `BELL_SEED` — the seed stays a **provenance fixture**: the
///   round-S signature is not available, so no bell seed is derived from
///   one. The anchors of the other bells follow the T model unsigned
///   (nothing opens against them). The reveal window is 600 s (the
///   deployed minimum); gathers, resolves and settles run after the real
///   close (`A + 600`) and the settle grace (600 s more).
/// * **The seals.** The vector's IBE block and recorded key `k`; the wide
///   body each march's own plaintext (the full host reference, the arrival
///   bell, the destination, its tile, the walked path) sealed under `k`,
///   the commitment under `salt_of(k)`, the root over the assembled seal.
///
/// Three hosts, **one arrival bell (20), one destination**: host A of
/// Citizen a (slot `i = 0`), host B of Citizen b (`i = 1`; one arrival per
/// Citizen per bell is the quota, so a second Citizen with its own wide
/// holding), host C of Citizen a (never revealed):
///
/// * A's seal opens with the real pairing and FO check and is judged
///   **valid**: the escrow — a **nonzero** tip, march fee and seal bond
///   (the Season's fee and bond are fixtures set here; the harness Season
///   carries none; the deployed Depart escrows `tip + fee + bond`) — is
///   paid **once** to **three distinct wallets**: the tip to the slot's
///   beneficiary, the fee to the resolver, the bond to the holding's rent
///   payer; the record and the slot (not claim-eligible: no priority
///   evidence) close to their rent recipients; the host stays; the
///   receipt carries the verdict and the three amounts; a replay finds no
///   record and moves nothing;
/// * B's seal is the same IBE block with one byte of `V` flipped (the root
///   the departure committed to is that seal's): the real pairing yields
///   another `sigma`, the FO check fails (code 1), and the march is
///   **confiscated** as deployed: the whole escrow to the settler's
///   beneficiary (a fourth wallet), the entry at the destination
///   forfeited, nothing home, the negative receipt;
/// * C's seal is well formed and opens, but its plaintext names arrival
///   bell 19 while the record says 20: the judge's own host/bell
///   validation — a semantic branch of `judge_wide`, code 5 — makes it a
///   bad seal with no fate to forfeit: the escrow to the settler's
///   beneficiary, no slot, no entry.
///
/// Bindings as refusals that write nothing: time (`TooEarly` 30 s before
/// `close + 600 s`), region (another region's anchor of the bell,
/// `BadAddress`), the stored root (`CommitMismatch` — the departure's
/// commitment check, which precedes every cryptographic step and is not a
/// BLS binding), the destination (a third present province of the
/// anchor's region: the seal opens valid and the plaintext's destination
/// refuses the account, `BadAddress`).
///
/// **What is still a fixture.** The departures are staged as in the march
/// test (`DEPART_DEBIT_ENABLED` stays false and is not opened for this);
/// the bell seeds are literals; the anchors were not posted by PostSeed
/// (their bytes are written by the harness, with the verified signature).
#[cfg(all(
    feature = "native-crypto-tests",
    not(feature = "test-beacon"),
    not(target_os = "solana")
))]
#[test]
fn wide_land_native_settles_a_real_wide_seal_and_confiscates_a_bad_one() {
    use crate::crypto::quick;
    use crate::crypto::seal::tests::{cases, get, hex};
    use crate::crypto::sys;
    use frontier_abi::log::{seal_code, transit_outcome as TO};
    use frontier_abi::world_index::march::{MarchState, WideTransit, WIDE_TRANSIT_LEN};
    use frontier_abi::world_index::seal as wseal;
    use frontier_abi::world_index::tiles::TileAddress;
    use permutation_rules::frontier::beacon::{bell_end, NO_WINDOW_CHANGE};
    use permutation_rules::frontier::doctrine::of_faction_v3;
    use permutation_rules::frontier::geometry::REGIONS;
    use permutation_rules::frontier::seal as ks;
    use permutation_rules::frontier::stance::{Posture, Stance};
    const Q3_ROUND: u64 = 32_556_137;
    const Q3_ROUND_TS: i64 = 1_790_471_775;
    const Q3_GENESIS: i64 = 1_790_459_175;
    const PAYER3: [u8; 32] = [0xd6; 32];
    const PAYER4: [u8; 32] = [0xd7; 32];
    let _g = begin();
    let mut w = Wide::rim();
    // The Season under the real beacon (fixtures on the harness Season:
    // the genesis that makes T(20) the vector's round, the deployed
    // minimum reveal window, a march fee and a seal bond).
    let (fee, bond) = (7_000u64, 11_000u64);
    {
        let mut sd = w.w.season.try_borrow_mut_data().unwrap();
        put(&mut sd, S::GENESIS_TS, &Q3_GENESIS.to_le_bytes());
        put(&mut sd, S::REVEAL_WINDOW, &600u32.to_le_bytes());
        put(
            &mut sd,
            S::WINDOW_FROM_BELL,
            &NO_WINDOW_CHANGE.to_le_bytes(),
        );
        put(&mut sd, S::MARCH_FEE, &fee.to_le_bytes());
        put(&mut sd, S::SEAL_BOND, &bond.to_le_bytes());
    }
    w.beacon_t = true;
    let clock = w.clock();
    assert_eq!(clock.genesis_ts, Q3_GENESIS);
    assert_eq!(
        (clock.drand_genesis, clock.drand_period),
        (1_692_803_367, 3),
        "quicknet"
    );
    assert_eq!(bell_end(Q3_GENESIS, 20), Q3_ROUND_TS);
    assert_eq!(clock.round_time(Q3_ROUND), Q3_ROUND_TS);
    assert_eq!(
        clock.tlock_round(20),
        Q3_ROUND,
        "T(20) is the vector's round"
    );
    assert_eq!(clock.window(20), 600);
    let (a20, t20, s20) = w.beacon_rounds(20);
    assert_eq!((a20, t20), (Q3_ROUND_TS + 30, Q3_ROUND));
    assert!(s20 > t20);

    // --- The real seal material (public): the vector's IBE block, its
    // recorded key and its round signature, verified against the
    // production quicknet key before anything is staged.
    let fixtures = cases();
    let vec_q3 = fixtures
        .iter()
        .find(|c| get(c, "name") == "valid_q3")
        .unwrap();
    assert_eq!(get(vec_q3, "round"), "32556137");
    let legacy: [u8; ks::SEAL_LEN] = hex(get(vec_q3, "seal")).try_into().unwrap();
    let ibe: [u8; wseal::IBE_LEN] = legacy[..wseal::IBE_LEN].try_into().unwrap();
    let k: [u8; ks::K_LEN] = hex(get(vec_q3, "k")).try_into().unwrap();
    let sig48: [u8; 48] = hex(get(vec_q3, "open_sig")).try_into().unwrap();
    let sig96 = sys::bls_g1_decompress(&sig48).unwrap();
    assert_eq!(
        quick::verify(Q3_ROUND, &sig48, &quick::tests::hints_for_round(Q3_ROUND)),
        Ok(sig96),
        "the production key signed round 32556137 = T(20) with this signature"
    );
    assert!(quick::verify(
        Q3_ROUND + 1,
        &sig48,
        &quick::tests::hints_for_round(Q3_ROUND + 1)
    )
    .is_err());
    let salt = ks::salt_of(&k);
    let arrive = 20u32;

    w.at(1, 0);
    let (coord, site, a, template) = w.land();
    let payer = w.w.payer.clone();
    let payer2 = w.wallet_of(PAYER2);
    let payer3 = w.wallet_of(PAYER3);
    let payer4 = w.wallet_of(PAYER4);
    let dest = c(129, -1);
    assert_eq!(w.open_province(129, -1), Ok(()));
    let region = wr::wide_region(dest);
    // A third present province of the destination's region, for the
    // destination-binding refusal (a march sealed to `dest`, settled
    // naming this one).
    let other_dest = {
        let q = (-129..=-2i64)
            .rev()
            .find(|&q| {
                let cq = c(129, q);
                cq.wedge().is_some() && wr::wide_region(cq) == region
            })
            .expect("a ring-129 province of the destination's region");
        assert_eq!(w.open_province(129, q), Ok(()));
        c(129, q)
    };
    // Two Citizens of one faction, each with a rim home and a wide
    // holding on the origin (one arrival per Citizen per bell is the
    // quota: two hosts at one bell need two Citizens).
    let b = w.w.member(WALLET_B, a.faction);
    w.fixture_rim_home(&a, &template, 0, 1_500 * MILLI);
    w.fixture_rim_home(&b, &template, 1, 1_500 * MILLI);
    let site_b = {
        let pd = w.province_data(coord);
        (0..pd[PV::SITE_COUNT])
            .find(|s| *s != site && pd[PV::site(*s as usize) + SM::STATE] == SM::STATE_FREE)
            .expect("a free site for the second holding")
    };
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)),
        Ok(())
    );
    assert_eq!(
        code(w.file(&b, WALLET_B, coord, site_b, 2, 1, payer.clone(), None)),
        Ok(())
    );
    assert_eq!(code(w.settle(&a, 0, coord, site, 1, None)), Ok(()));
    assert_eq!(code(w.settle(&b, 0, coord, site_b, 1, None)), Ok(()));
    records();
    wide_records();
    let key = ProvinceKey::new(w.world_id(), coord);
    let dkey = ProvinceKey::new(w.world_id(), dest);

    // --- Bell 4 + 120 s: the holdings final (the tickets' `final_ts`,
    // `round_time(S(1)) + 600`, has passed), the origin resolved through
    // bell 2 (bell 2's window closed at its anchor's `A + 600`), the three
    // hosts mustered.
    let ts = w.at(4, 120);
    assert!(w.final_ts_of(1) <= ts, "the tickets' finality is due");
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    assert_eq!(code(w.finalize(coord, site_b)), Ok(()));
    for bell in 1..=2 {
        assert_eq!(code(w.resolve(coord, bell)), Ok(()), "origin bell {bell}");
    }
    for s in [site, site_b] {
        let hai = w.holding(coord, s);
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::reserve(0), &1_000u32.to_le_bytes());
    }
    let (tile_a, tile_b, tile_c) = {
        let pd = w.province_data(coord);
        let passable = Ro(&pd).u64(PV::PASSABLE_MASK).unwrap();
        let keep_tile = read_keep(&pd).unwrap().map(|k| k.tile);
        let camp = Camp::read(&pd).unwrap();
        let camp_tile = camp.present().then_some(camp.tile);
        let n_sites = pd[PV::SITE_COUNT] as usize;
        let sites = pd[PV::SITES..PV::SITES + n_sites].to_vec();
        let mut free = (1..61u8).filter(|t| {
            passable & (1 << t) != 0
                && Some(*t) != keep_tile
                && Some(*t) != camp_tile
                && !sites.contains(t)
        });
        (
            free.next().expect("a passable tile"),
            free.next().expect("a second passable tile"),
            free.next().expect("a third passable tile"),
        )
    };
    assert_eq!(
        code(w.muster(&a, WALLET_A, coord, site, 0, 300, tile_a)),
        Ok(())
    );
    assert_eq!(
        code(w.muster(&b, WALLET_B, coord, site_b, 0, 200, tile_b)),
        Ok(())
    );
    assert_eq!(
        code(w.muster(&a, WALLET_A, coord, site, 0, 100, tile_c)),
        Ok(())
    );
    let host_a = WideHostRef::new(key, site, 1, 0).unwrap();
    let host_b = WideHostRef::new(key, site_b, 1, 0).unwrap();
    let host_c = WideHostRef::new(key, site, 1, 1).unwrap();
    records();
    wide_records();

    // --- Bell 6 + 60 s: bells 3 and 4 resolved (bell 4's close at `A +
    // 600`, 630 s into bell 6 at most... its anchor's `A` is 30 s into
    // bell 5, so its close is 30 s into bell 6): the hosts resident.
    w.at(6, 60);
    for bell in 3..=4 {
        assert_eq!(code(w.resolve(coord, bell)), Ok(()), "origin bell {bell}");
    }
    let entry_of = |pd: &[u8], host: &WideHostRef| {
        (0..PV::ENTRIES_N)
            .find(|&i| read_entry(pd, i).unwrap().id == wide_host_alias(host))
            .expect("the host's entry")
    };
    let (idx_a, idx_b, idx_c) = {
        let pd = w.province_data(coord);
        let idx = (
            entry_of(&pd, &host_a),
            entry_of(&pd, &host_b),
            entry_of(&pd, &host_c),
        );
        for i in [idx.0, idx.1, idx.2] {
            assert_eq!(read_entry(&pd, i).unwrap().state, EN::STATE_ROSTER);
        }
        idx
    };

    // --- THE anchor of bell 20: round T(20), `A = round_time(T) + 30`,
    // the verified signature; the SeedCache `S(20, A)` with the literal
    // seed. Staged before any reader.
    let (_, anchor20) = w.stage_beacon_signed(arrive, region, &BELL_SEED, sig48);
    {
        let an = crate::layout::beacon::Anchor::read(&anchor20.try_borrow_data().unwrap()).unwrap();
        assert_eq!(
            (an.bell, an.region, an.round, an.a, an.sig48),
            (arrive, region, Q3_ROUND, a20, sig48)
        );
    }
    let (dest_tile_a, dirs_a, via_a) = march_route(&mut w, coord, dest, tile_a);
    let (dest_tile_b, dirs_b, via_b) = march_route(&mut w, coord, dest, tile_b);
    let (dest_tile_c, dirs_c, _via_c) = march_route(&mut w, coord, dest, tile_c);
    let seal_of = |host: WideHostRef, bell: u32, dest_tile: u8, dirs: &[u8], tamper_v: bool| {
        let (path_len, path) = ks::encode_path(dirs).unwrap();
        let plain = wseal::WidePlain {
            version: wseal::WIDE_PLAIN_VERSION,
            host,
            arrive_bell: bell,
            dest: dkey,
            dest_tile,
            stance: 0,
            retreat_bps: 0,
            path_len,
            path,
            reserved: [0; wseal::WIDE_RESERVED_BYTES],
        };
        assert_eq!(wseal::validate(&plain, &host, bell), Ok(()));
        let pt = wseal::pack(&plain);
        let mut seal = wseal::assemble(&ibe, &wseal::body_xor(&k, &pt));
        if tamper_v {
            seal[ks::SEAL_V] ^= 1;
        }
        let commit = wseal::commit(&pt, &salt);
        let ct_hash = wseal::ct_hash(&seal);
        let root = wseal::seal_root(&commit, &ct_hash);
        (pt, seal, commit, ct_hash, root)
    };
    let (pt_a, seal_a, commit_a, ct_a, root_a) =
        seal_of(host_a, arrive, dest_tile_a, &dirs_a, false);
    let (pt_b, seal_b, commit_b, ct_b, root_b) =
        seal_of(host_b, arrive, dest_tile_b, &dirs_b, true);
    // C: a well-formed seal whose plaintext names bell 19 while its record
    // says 20 (the judge's host/bell validation, code 5).
    let (_pt_c, seal_c, commit_c, _ct_c, root_c) =
        seal_of(host_c, arrive - 1, dest_tile_c, &dirs_c, false);
    assert_eq!(
        &seal_a[..wseal::IBE_LEN],
        &ibe[..],
        "the vector's IBE block"
    );
    assert_ne!(seal_b[ks::SEAL_V], ibe[ks::SEAL_V], "one byte of V flipped");

    // --- The departures as WideDepart would write them after the gate
    // (**fixtures**: the gate is closed): all at bell 6 to bell 20, the
    // records with the fee and the bond escrowed, the entries' `Spend`,
    // each holding's escrow and open count.
    let dealt = of_faction_v3(a.faction)
        .unwrap()
        .dealt_bps(Posture::Stance(Stance::Hold), true) as u16;
    let tip = w.min_tip();
    assert!(tip > 0 && fee > 0 && bond > 0);
    let total = tip + fee + bond;
    let rent_t = crate::init::rent(WIDE_TRANSIT_LEN).unwrap();
    let depart_ts = w.genesis() + 600 * 6 + 60;
    for (hsite, slot, host, tile, mass, root) in [
        (site, 0u8, host_a, tile_a, 300_000u32, root_a),
        (site_b, 0, host_b, tile_b, 200_000, root_b),
        (site, 1, host_c, tile_c, 100_000, root_c),
    ] {
        let staged = WideTransit::depart(
            HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            a.faction,
            TileAddress::new(key, tile).unwrap(),
            6,
            arrive,
            depart_ts,
            mass,
            crate::proc::host::DEPART_STAMINA,
            dealt,
            root,
            tip,
            crate::layout::transit::FLAG_FEE_ESCROWED | crate::layout::transit::FLAG_BOND_ESCROWED,
            PAYER,
        )
        .unwrap();
        let t = w.transit(coord, hsite, slot);
        restore(
            &t,
            rent_t,
            &staged.to_bytes(),
            Pubkey::new_from_array(PROGRAM),
        );
    }
    {
        let pa = w.province(coord);
        let mut pd = pa.try_borrow_mut_data().unwrap();
        for i in [idx_a, idx_b, idx_c] {
            let mut e = read_entry(&pd, i).unwrap();
            let mut kh = e.to_host().unwrap();
            kh.depart(6, crate::proc::host::DEPART_STAMINA, 5).unwrap();
            e.set_host(&kh);
            write_entry(&mut pd, i, &e).unwrap();
            assert!(matches!(e.op, EntryOp::Spend { .. }));
        }
    }
    for (hsite, n) in [(site, 2u8), (site_b, 1)] {
        let hai = w.holding(coord, hsite);
        **hai.try_borrow_mut_lamports().unwrap() += total * n as u64;
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::ESCROW, &(total * n as u64).to_le_bytes());
        hd[wh::wide_holding::OPEN_TRANSITS] = n;
    }
    wide_records();

    // --- Bell 8 + 60 s: bells 5 and 6 resolved (the `Spend` of 6: the
    // hosts departed), the three departures settled. At bell 21 + 60, A and B reveal at
    // the destination with the real commitments and ciphertext hashes
    // (the window of bell 20 closes at `A + 600`, 630 s into bell 21), A's
    // slot beneficiary a second wallet; C never reveals.
    w.at(8, 60);
    for bell in 5..=6 {
        assert_eq!(code(w.resolve(coord, bell)), Ok(()), "origin bell {bell}");
    }
    assert_eq!(code(w.settle_departure(host_a, coord, 0)), Ok(()));
    assert_eq!(code(w.settle_departure(host_b, coord, 0)), Ok(()));
    assert_eq!(code(w.settle_departure(host_c, coord, 1)), Ok(()));
    for (hsite, slot, mass) in [
        (site, 0u8, 300_000u32),
        (site_b, 0, 200_000),
        (site, 1, 100_000),
    ] {
        let t = WideTransit::from_bytes(&w.transit(coord, hsite, slot).try_borrow_data().unwrap())
            .unwrap();
        assert_eq!((t.state, t.troops_after), (MarchState::Settled, mass));
    }
    // Reveal only after the public T signature is available (A = bell 21 + 30).
    w.at(21, 60);
    assert_eq!(
        code(w.reveal_as(host_a, 0, dest, arrive, 0, pt_a, salt, ct_a, &via_a, PAYER2)),
        Ok(())
    );
    assert_eq!(
        code(w.reveal_as(host_b, 0, dest, arrive, 1, pt_b, salt, ct_b, &via_b, PAYER2)),
        Ok(()),
        "the smaller host of the other Citizen fills slot 1"
    );
    wide_records();

    // --- Bell 21 + 60 s: the destination and the third province through
    // bell 19 (bell 19's close is 30 s into bell 21).
    w.at(21, 60);
    for prov in [dest, other_dest] {
        let rn0 = Ro(&w.province_data(prov)).u32(PV::RESOLVED_NEXT).unwrap();
        for bell in rn0..arrive {
            assert_eq!(code(w.resolve(prov, bell)), Ok(()), "bell {bell}");
        }
    }
    wide_records();

    // --- Bell 22 + 60 s: bell 20's window closed (`A + 600` = 30 s into
    // bell 22): the gather of both arrivals, the resolve by a third wallet
    // (the resolver), the third province's bell 20.
    w.at(22, 60);
    let k0 = wa::wide_clash_inputs::position(a.faction, 0);
    let mut ts = vec![w.w.system.clone(); 24];
    ts[k0] = w.transit(coord, site, 0);
    ts[k0 + 1] = w.transit(coord, site_b, 0);
    assert_eq!(code(w.gather(dest, arrive, 0, 24, &ts)), Ok(()));
    assert_eq!(code(w.resolve_gathered_as(dest, arrive, PAYER3)), Ok(()));
    assert_eq!(code(w.resolve(other_dest, arrive)), Ok(()));
    wide_records();
    let (i_a, i_b) = {
        let pd = w.province_data(dest);
        let (ia, ib) = (entry_of(&pd, &host_a), entry_of(&pd, &host_b));
        assert_eq!(read_entry(&pd, ia).unwrap().state, EN::STATE_ROSTER);
        assert_eq!(read_entry(&pd, ib).unwrap().state, EN::STATE_ROSTER);
        (ia, ib)
    };
    {
        let cd = w.inputs(dest, arrive).try_borrow_data().unwrap().to_vec();
        let ih = wa::WideClashInputsHdr::read(&cd).unwrap();
        assert_eq!((ih.n_present, ih.resolver), (2, PAYER3));
    }
    let balances = |w: &mut Wide| {
        (
            payer.lamports(),
            payer2.lamports(),
            payer3.lamports(),
            payer4.lamports(),
            w.holding(coord, site).lamports(),
            w.holding(coord, site_b).lamports(),
        )
    };

    // --- Bell 23: 30 s before the settle grace ends (`A + 600 + 600`):
    // time binding. Bell 23 + 60 s: the other bindings, then the
    // settlements.
    w.at(23, 0);
    let before = balances(&mut w);
    assert_eq!(
        code(w.settle_transit_full(
            host_a,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit_a,
            seal_a,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Err(E::TooEarly as u32),
        "600 s after the close"
    );
    w.at(23, 60);
    let other_region = (region + 1) % REGIONS;
    let (_, wrong_anchor) = w.stage_seed(arrive, other_region, &BELL_SEED);
    assert_eq!(
        code(w.settle_transit_full(
            host_a,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit_a,
            seal_a,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            Some(wrong_anchor)
        )),
        Err(E::BadAddress as u32),
        "region binding: the anchor of another region"
    );
    assert_eq!(
        code(w.settle_transit_full(
            host_a,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit_b,
            seal_a,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Err(E::CommitMismatch as u32),
        "the stored root: the departure's commitment, checked before any crypto"
    );
    assert_eq!(
        code(w.settle_transit_full(
            host_a,
            0,
            other_dest,
            arrive,
            a.faction,
            0,
            commit_a,
            seal_a,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Err(E::BadAddress as u32),
        "destination binding: the seal opens valid and names the destination, not this province"
    );
    assert_eq!(balances(&mut w), before, "refusals move nothing");
    assert!(
        wide_records().is_empty() && records().is_empty(),
        "refusals log nothing"
    );

    // --- A: the valid settlement, each amount to its own wallet, once.
    let rent_s = crate::init::rent(wa::wide_arrival_slot::SIZE).unwrap();
    let slot_a = w.slot(dest, arrive, a.faction, 0);
    let transit_a = w.transit(coord, site, 0);
    assert_eq!(
        code(w.settle_transit_full(
            host_a,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit_a,
            seal_a,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Ok(()),
        "a real seal, opened with the real round signature, judged valid"
    );
    let after = balances(&mut w);
    assert_eq!(after.1 - before.1, tip, "the tip to the slot's beneficiary");
    assert_eq!(after.2 - before.2, fee, "the fee to the resolver");
    assert_eq!(
        after.0 - before.0,
        bond + rent_s + rent_t,
        "the bond to the holding's rent payer, with the slot's and the record's rent (its recipient)"
    );
    assert_eq!(
        after.3, before.3,
        "the settler's beneficiary: nothing on a valid seal"
    );
    assert_eq!(
        before.4 - after.4,
        total,
        "the holding paid the escrow once"
    );
    assert_eq!(after.5, before.5);
    {
        let hd = w.holding_data(coord, site);
        assert_eq!(Ro(&hd).u64(H::ESCROW).unwrap(), total, "C's escrow stays");
        assert_eq!(Ro(&hd).u64(H::POOL_OWED).unwrap(), 0, "nothing diverted");
        assert_eq!(WideHolding::read(&hd).unwrap().open_transits, 1);
    }
    assert!(absent(&transit_a), "the record to its rent recipient");
    assert!(
        absent(&slot_a),
        "the slot, not claim-eligible (no priority evidence), to its rent recipient"
    );
    {
        let cd = w.inputs(dest, arrive).try_borrow_data().unwrap().to_vec();
        let ih = wa::WideClashInputsHdr::read(&cd).unwrap();
        assert_eq!(ih.settled_mask, 1 << k0, "A's position settled");
    }
    {
        let e = read_entry(&w.province_data(dest), i_a).unwrap();
        assert_eq!(
            (e.state, e.op),
            (EN::STATE_ROSTER, EntryOp::None),
            "A stays"
        );
    }
    let wr = wide_records();
    assert_eq!(wr.len(), 1, "the settlement; the host stays, so no Return");
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::TransitSettled, 23));
        assert_eq!(
            (r.host(), r.standing(), r.home_of()),
            (Some(host_a), Some(dkey), Some(key))
        );
        assert_eq!(
            &r.payload[..3],
            &[0, wa::wide_arrival::FATE_STAYS, seal_code::VALID]
        );
        assert_eq!(&r.payload[3..7], &300_000u32.to_le_bytes());
        assert_eq!(&r.payload[7..15], &tip.to_le_bytes());
        assert_eq!(&r.payload[15..23], &fee.to_le_bytes());
        assert_eq!(&r.payload[23..31], &bond.to_le_bytes());
        assert_eq!(r.payload[31], 0, "nothing home");
        assert_eq!(r.sealed_dest(), Some(dkey));
        assert!(r.link(WideEntity::Province).is_some() && r.link(WideEntity::Holding).is_some());
    }
    assert!(
        records().is_empty(),
        "no DIVERT: every recipient took its payment"
    );
    let before = after;
    assert_eq!(
        code(w.settle_transit_full(
            host_a,
            0,
            dest,
            arrive,
            a.faction,
            0,
            commit_a,
            seal_a,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Err(E::TransitState as u32),
        "replay: the record is gone"
    );
    assert_eq!(balances(&mut w), before, "a replay moves nothing");

    // --- B: the bad seal (FO failure under the real pairing), confiscated.
    let slot_b = w.slot(dest, arrive, a.faction, 1);
    let transit_b = w.transit(coord, site_b, 0);
    assert_eq!(
        code(w.settle_transit_full(
            host_b,
            0,
            dest,
            arrive,
            a.faction,
            1,
            commit_b,
            seal_b,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Ok(()),
        "a bad seal is a verdict, not a refusal"
    );
    let after = balances(&mut w);
    assert_eq!(
        after.3 - before.3,
        total,
        "the whole escrow to the settler's beneficiary: the confiscation, once"
    );
    assert_eq!(after.0 - before.0, rent_s + rent_t, "only the rents");
    assert_eq!((after.1, after.2), (before.1, before.2), "no tip, no fee");
    assert_eq!(before.5 - after.5, total);
    assert_eq!(after.4, before.4);
    {
        let hd = w.holding_data(coord, site_b);
        assert_eq!(Ro(&hd).u64(H::ESCROW).unwrap(), 0);
        assert_eq!(Ro(&hd).u64(H::POOL_OWED).unwrap(), 0);
        assert_eq!(WideHolding::read(&hd).unwrap().open_transits, 0);
    }
    assert!(absent(&transit_b) && absent(&slot_b));
    {
        let e = read_entry(&w.province_data(dest), i_b).unwrap();
        assert_eq!(
            (e.state, e.op, e.pend_bell),
            (EN::STATE_ROSTER, EntryOp::Forfeit, 23),
            "the entry that stayed is forfeited"
        );
    }
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.bell), (WideKind::TransitSettled, 23));
        assert_eq!((r.host(), r.standing()), (Some(host_b), Some(dkey)));
        assert_eq!(&r.payload[..3], &[0, TO::BAD_SEAL, seal_code::FO_FAILED]);
        assert_eq!(&r.payload[3..7], &0u32.to_le_bytes());
        assert_eq!(
            &r.payload[7..31],
            &[0u8; 24],
            "no tip, fee or bond paid: all confiscated"
        );
        assert_eq!(r.payload[31], 0);
        assert_eq!(r.sealed_dest(), Some(dkey));
    }
    assert!(records().is_empty());
    let before = after;
    assert_eq!(
        code(w.settle_transit_full(
            host_b,
            0,
            dest,
            arrive,
            a.faction,
            1,
            commit_b,
            seal_b,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Err(E::TransitState as u32),
        "replay"
    );
    assert_eq!(balances(&mut w), before);

    // --- C: a seal that opens, whose plaintext names another bell than
    // its record (the judge's host/bell validation: code 5, a bad seal
    // with no fate). Never revealed: no slot, no entry; the escrow to the
    // settler's beneficiary; only the record's rent to its recipient.
    let transit_c = w.transit(coord, site, 1);
    assert!(
        absent(&w.slot(dest, arrive, a.faction, 0)),
        "A's slot is gone: C has none"
    );
    assert_eq!(
        code(w.settle_transit_full(
            host_c,
            1,
            dest,
            arrive,
            a.faction,
            0,
            commit_c,
            seal_c,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Ok(())
    );
    let after = balances(&mut w);
    assert_eq!(
        after.3 - before.3,
        total,
        "confiscated to the settler's beneficiary"
    );
    assert_eq!(after.0 - before.0, rent_t, "the record's rent only");
    assert_eq!((after.1, after.2), (before.1, before.2));
    assert_eq!(before.4 - after.4, total);
    {
        let hd = w.holding_data(coord, site);
        assert_eq!(Ro(&hd).u64(H::ESCROW).unwrap(), 0);
        assert_eq!(WideHolding::read(&hd).unwrap().open_transits, 0);
    }
    assert!(absent(&transit_c));
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.host()), (WideKind::TransitSettled, Some(host_c)));
        assert_eq!(
            &r.payload[..3],
            &[1, TO::BAD_SEAL, seal_code::BAD_PLAINTEXT]
        );
        assert_eq!(&r.payload[3..31], &[0u8; 28]);
        assert_eq!(r.sealed_dest(), Some(dkey));
    }
    assert!(records().is_empty());
    let before = after;
    assert_eq!(
        code(w.settle_transit_full(
            host_c,
            1,
            dest,
            arrive,
            a.faction,
            0,
            commit_c,
            seal_c,
            payer.clone(),
            payer2.clone(),
            payer3.clone(),
            payer4.clone(),
            None
        )),
        Err(E::TransitState as u32),
        "replay"
    );
    assert_eq!(balances(&mut w), before);
    assert!(wide_records().is_empty() && records().is_empty());
}

/// The season-end cleanup of the march records under the deployed closes'
/// own case rules, over records staged at their canonical addresses
/// (**fixtures**: the bytes the reveal, the gather, the resolve and the
/// departure leave). A wide ArrivalSlot closes once settled and claimed or
/// past its claim grace against THE anchor (case a), not before; a wide
/// ArrivalDay once the province resolved every bell of its day; a wide
/// ClashInputs once resolved, every present position settled and the
/// close grace passed (`InputsOpen` before); each to its immutable rent
/// recipient, another refused. A transit record left open has no close
/// while the Season runs; at Ended + 72 h the holding closes to its rent
/// payer **with the escrow of the unsettled march**, exactly as the
/// deployed CloseHolding does, and the transit record then closes to its
/// own rent recipient, the holding gone. No lamport is paid twice.
#[test]
fn wide_land_season_end_closes_the_march_records_as_the_deployed_closes_do() {
    use frontier_abi::world_index::march::{WideTransit, WIDE_TRANSIT_LEN};
    use frontier_abi::world_index::tiles::TileAddress;
    let _g = begin();
    at_bell(1);
    let mut w = Wide::rim();
    let (coord, site, a, template) = w.land();
    let payer = w.w.payer.clone();
    let payer2 = w.wallet_of(PAYER2);
    let dest = c(129, -1);
    assert_eq!(w.open_province(129, -1), Ok(()));
    w.fixture_rim_home(&a, &template, 0, 1_500 * MILLI);
    assert_eq!(
        code(w.file(&a, WALLET_A, coord, site, 2, 0, payer.clone(), None)),
        Ok(())
    );
    assert_eq!(code(w.settle(&a, 0, coord, site, 1, None)), Ok(()));
    at_bell(3);
    assert_eq!(code(w.finalize(coord, site)), Ok(()));
    records();
    wide_records();
    let key = ProvinceKey::new(w.world_id(), coord);
    let dkey = ProvinceKey::new(w.world_id(), dest);
    // The host mustered for real (the identity allocated at the holding's
    // first muster, the roster created from the payer, the entry resident
    // after the next resolve): the state a departure leaves from, and the
    // one a holding with an open march is in.
    {
        let hai = w.holding(coord, site);
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::reserve(0), &500u32.to_le_bytes());
    }
    let origin_tile = {
        let pd = w.province_data(coord);
        let passable = Ro(&pd).u64(PV::PASSABLE_MASK).unwrap();
        let keep_tile = read_keep(&pd).unwrap().map(|k| k.tile);
        let camp = Camp::read(&pd).unwrap();
        let camp_tile = camp.present().then_some(camp.tile);
        let n_sites = pd[PV::SITE_COUNT] as usize;
        let sites = pd[PV::SITES..PV::SITES + n_sites].to_vec();
        (1..61u8)
            .find(|t| {
                passable & (1 << t) != 0
                    && Some(*t) != keep_tile
                    && Some(*t) != camp_tile
                    && !sites.contains(t)
            })
            .expect("a passable tile")
    };
    for b in 1..=2 {
        assert_eq!(code(w.resolve(coord, b)), Ok(()));
        assert_eq!(code(w.resolve(dest, b)), Ok(()));
    }
    assert_eq!(
        code(w.muster(&a, WALLET_A, coord, site, 0, 300, origin_tile)),
        Ok(())
    );
    let host = WideHostRef::new(key, site, 1, 0).unwrap();
    at_bell(4);
    assert_eq!(code(w.resolve(coord, 3)), Ok(()));
    assert_eq!(code(w.resolve(dest, 3)), Ok(()));
    assert_eq!(
        read_entry(&w.province_data(coord), 0).unwrap().state,
        EN::STATE_ROSTER
    );
    wide_records();
    let wedge = WideProvince::read(&w.province_data(coord)).unwrap().wedge;
    let dwedge = WideProvince::read(&w.province_data(dest)).unwrap().wedge;
    let bell = 20u32;
    let f = a.faction;
    let k = wa::wide_clash_inputs::position(f, 0);
    let tile = {
        let pd = w.province_data(dest);
        let passable = Ro(&pd).u64(PV::PASSABLE_MASK).unwrap();
        (1..61u8)
            .find(|t| passable & (1 << t) != 0)
            .expect("a passable tile")
    };
    // **Fixtures** at the canonical addresses, the rent recipient a second
    // wallet so the refunds are visible.
    let rent_s = crate::init::rent(wa::wide_arrival_slot::SIZE).unwrap();
    let rent_d = crate::init::rent(wa::wide_arrival_day::SIZE).unwrap();
    let rent_i = crate::init::rent(wa::wide_clash_inputs::SIZE).unwrap();
    let rent_t = crate::init::rent(WIDE_TRANSIT_LEN).unwrap();
    let slot_rec = wa::WideArrivalSlot {
        season_id: SEASON_ID,
        dest: dkey,
        bell,
        faction: f,
        i: 0,
        transit_slot: 0,
        host,
        citizen: a.key,
        unit: 0,
        stance: 0,
        tile,
        retreat_bps: 0,
        dealt_bps: 10_000,
        dep_mass: 300_000,
        flags: 0,
        beneficiary: PAYER,
        rent_to: PAYER2,
        ev_slot: 1_005,
        ev_price: 0,
        ev_limit: 0,
        ev_loaded: 0,
        claimed: false,
    };
    let mut sb = vec![0u8; wa::wide_arrival_slot::SIZE];
    slot_rec.write(&mut sb).unwrap();
    let slot_ai = w.slot(dest, bell, f, 0);
    restore(&slot_ai, rent_s, &sb, Pubkey::new_from_array(PROGRAM));
    // two more slots of the cohort: index 1 unsettled and unclaimed (closed
    // under the tombstone below), index 2 settled **and claimed** (the
    // deployed short-circuit: no anchor is read)
    let slot1_ai = w.slot(dest, bell, f, 1);
    {
        let mut s1 = slot_rec;
        s1.i = 1;
        let mut b = vec![0u8; wa::wide_arrival_slot::SIZE];
        s1.write(&mut b).unwrap();
        restore(&slot1_ai, rent_s, &b, Pubkey::new_from_array(PROGRAM));
        let mut s2 = slot_rec;
        s2.i = 2;
        s2.flags = wa::wide_arrival_slot::FLAG_SETTLED;
        s2.claimed = true;
        let mut b = vec![0u8; wa::wide_arrival_slot::SIZE];
        s2.write(&mut b).unwrap();
        let slot2_ai = w.slot(dest, bell, f, 2);
        restore(&slot2_ai, rent_s, &b, Pubkey::new_from_array(PROGRAM));
    }
    let mut day_rec = wa::WideArrivalDay::new(SEASON_ID, dkey, 0, PAYER2);
    assert!(day_rec.set(bell));
    let mut db = vec![0u8; wa::wide_arrival_day::SIZE];
    day_rec.write(&mut db).unwrap();
    let day_ai = w.day(dest, bell);
    restore(&day_ai, rent_d, &db, Pubkey::new_from_array(PROGRAM));
    let mut ih = wa::WideClashInputsHdr::new(SEASON_ID, dkey, bell, PAYER2);
    ih.flags = wa::wide_clash_inputs::FLAG_RESOLVED;
    ih.n_present = 1;
    ih.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    ih.resolver = PAYER;
    let mut cb = vec![0u8; wa::wide_clash_inputs::SIZE];
    ih.write(&mut cb).unwrap();
    wa::WideArrival {
        host,
        citizen: a.key,
        dep_mass: 300_000,
        troops: 300_000,
        stamina: 61,
        retreat_bps: 0,
        dealt_bps: 10_000,
        faction: f,
        unit: 0,
        tile,
        stance: 0,
        present: true,
        fate: wa::wide_arrival::FATE_STAYS,
        troops_after: 300_000,
    }
    .write_at(&mut cb, k)
    .unwrap();
    let inputs_ai = w.inputs(dest, bell);
    restore(&inputs_ai, rent_i, &cb, Pubkey::new_from_array(PROGRAM));
    let tip = w.min_tip();
    let transit = WideTransit::depart(
        HOST_IDENTITY_FULL_REF_V1,
        host,
        0,
        f,
        TileAddress::new(key, origin_tile).unwrap(),
        4,
        bell,
        GENESIS + 2_400,
        300_000,
        crate::proc::host::DEPART_STAMINA,
        10_000,
        [1; 32],
        tip,
        crate::layout::transit::FLAG_FEE_ESCROWED | crate::layout::transit::FLAG_BOND_ESCROWED,
        PAYER2,
    )
    .unwrap();
    let transit_ai = w.transit(coord, site, 0);
    restore(
        &transit_ai,
        rent_t,
        &transit.to_bytes(),
        Pubkey::new_from_array(PROGRAM),
    );
    {
        // the entry's pending `Spend` of the departure (bell 4), as
        // WideDepart writes it after the gate
        let pa = w.province(coord);
        let mut pd = pa.try_borrow_mut_data().unwrap();
        let mut e = read_entry(&pd, 0).unwrap();
        let mut kh = e.to_host().unwrap();
        kh.depart(4, crate::proc::host::DEPART_STAMINA, 4).unwrap();
        e.set_host(&kh);
        write_entry(&mut pd, 0, &e).unwrap();
        assert!(matches!(e.op, EntryOp::Spend { .. }));
    }
    {
        // the holding under that march: the escrow and the open count
        let hai = w.holding(coord, site);
        **hai.try_borrow_mut_lamports().unwrap() += tip;
        let mut hd = hai.try_borrow_mut_data().unwrap();
        put(&mut hd, H::ESCROW, &tip.to_le_bytes());
        hd[wh::wide_holding::OPEN_TRANSITS] = 1;
    }
    assert_eq!(
        WideHolding::read(&w.holding_data(coord, site))
            .unwrap()
            .open_transits,
        1
    );
    records();
    wide_records();

    // --- While the Season runs, the closes' own rules (the deployed
    // cases) apply; nothing closes before its case.
    at_bell(30);
    let p2 = payer2.lamports();
    assert_eq!(
        code(w.close_slot(dest, bell, f, 0, payer.clone(), None)),
        Err(E::BadAddress as u32),
        "the immutable rent recipient"
    );
    assert_eq!(
        code(w.close_slot(dest, bell, f, 0, payer2.clone(), None)),
        Err(E::TooEarly as u32),
        "not settled"
    );
    assert_eq!(
        code(w.close_day(dest, bell, payer2.clone())),
        Err(E::TooEarly as u32),
        "the day's bells are not resolved"
    );
    assert_eq!(
        code(w.close_inputs(dest, bell, payer2.clone())),
        Err(E::InputsOpen as u32),
        "a present position unsettled"
    );
    assert_eq!(
        code(w.close_transit(coord, site, 0, payer2.clone())),
        Err(E::WrongStatus as u32),
        "a transit record closes at season end only"
    );
    assert_eq!(
        code(w.close_province(coord, wedge)),
        Err(E::WrongStatus as u32),
        "a province closes at season end only"
    );
    assert_eq!(payer2.lamports(), p2);
    // The slot: settled, unclaimed, no anchor listed → not yet; THE anchor
    // listed with its claim grace passed → closes.
    {
        let mut sd = slot_ai.try_borrow_mut_data().unwrap();
        let mut s = wa::WideArrivalSlot::read(&sd).unwrap();
        s.flags |= wa::wide_arrival_slot::FLAG_SETTLED;
        s.write(&mut sd).unwrap();
    }
    assert_eq!(
        code(w.close_slot(dest, bell, f, 0, payer2.clone(), None)),
        Err(E::TooEarly as u32),
        "settled, unclaimed, no anchor: the grace is not known to have passed"
    );
    let region = crate::proc::wide::absent_destination_region(dest);
    assert_eq!(
        region,
        WideProvince::read(&w.province_data(dest)).unwrap().region,
        "the one region rule"
    );
    let (_, anchor) = w.stage_seed(bell, region, &BELL_SEED);
    assert_eq!(
        code(w.close_slot(dest, bell, f, 0, payer2.clone(), Some(anchor.clone()))),
        Ok(())
    );
    assert!(absent(&slot_ai));
    assert_eq!(payer2.lamports(), p2 + rent_s);
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.province()), (WideKind::RecordClosed, Some(dkey)));
        assert_eq!(r.payload[0], wix::CLOSE_WHAT_SLOT);
        assert_eq!(&r.payload[1..5], &bell.to_le_bytes());
        assert_eq!((r.payload[5], r.payload[6]), (f, 0));
        assert_eq!(&r.payload[7..39], &PAYER2);
        assert_eq!(&r.payload[39..47], &rent_s.to_le_bytes());
        assert_eq!(r.links, [None, None]);
    }
    // Settled and claimed: the deployed short-circuit, THE anchor is not
    // read — an unrelated account in the anchor position is not even
    // checked, and the slot closes on the claim alone.
    assert_eq!(
        code(w.close_slot(dest, bell, f, 2, payer2.clone(), Some(payer2.clone()))),
        Ok(()),
        "claimed: the anchor position is not read"
    );
    assert!(absent(&w.slot(dest, bell, f, 2)));
    assert_eq!(payer2.lamports(), p2 + 2 * rent_s);
    {
        let wr = wide_records();
        assert_eq!(wr.len(), 1);
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.payload[0], r.payload[6]), (wix::CLOSE_WHAT_SLOT, 2));
    }
    let p2 = p2 + rent_s;
    // The day: the province resolved through its last bell (**fixture**:
    // `resolved_next = 144`; the resolves are not run here) → closes.
    {
        let pa = w.province(dest);
        let mut pd = pa.try_borrow_mut_data().unwrap();
        put(
            &mut pd,
            PV::RESOLVED_NEXT,
            &wa::wide_arrival_day::BELLS.to_le_bytes(),
        );
    }
    assert_eq!(code(w.close_day(dest, bell, payer2.clone())), Ok(()));
    assert!(absent(&day_ai));
    assert_eq!(payer2.lamports(), p2 + rent_s + rent_d);
    {
        let wr = wide_records();
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.province()), (WideKind::RecordClosed, Some(dkey)));
        assert_eq!(r.payload[0], wix::CLOSE_WHAT_DAY);
        assert_eq!(
            &r.payload[1..5],
            &0u32.to_le_bytes(),
            "the day's first bell"
        );
        assert_eq!(&r.payload[39..47], &rent_d.to_le_bytes());
    }
    // The inputs: the present position settled and the grace passed
    // (`resolved_ts` 0, the Season's close grace from genesis) → closes.
    {
        let mut cd = inputs_ai.try_borrow_mut_data().unwrap();
        let mut h = wa::WideClashInputsHdr::read(&cd).unwrap();
        h.settled_mask = 1 << k;
        h.write(&mut cd).unwrap();
    }
    assert_eq!(code(w.close_inputs(dest, bell, payer2.clone())), Ok(()));
    assert!(absent(&inputs_ai));
    assert_eq!(payer2.lamports(), p2 + rent_s + rent_d + rent_i);
    {
        let wr = wide_records();
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.province()), (WideKind::RecordClosed, Some(dkey)));
        assert_eq!(r.payload[0], wix::CLOSE_WHAT_INPUTS);
        assert_eq!(&r.payload[1..5], &bell.to_le_bytes());
        assert_eq!(&r.payload[39..47], &rent_i.to_le_bytes());
    }
    assert!(records().is_empty(), "no PS2 record");

    // --- The deadline. Ended, one second before `end + 72 h`: nothing
    // closes, the march's rights stand. At the deadline the closes run in
    // this test's order — the holding, the transit record, the roster
    // over the pending `Spend`, the province — each whole to its own
    // immutable recipient, none reading another's account beyond its
    // canonical address, no lamport twice: the deployed expiry rule
    // (CloseHolding with "the escrow of unsettled transits included";
    // CloseProvince over the entry table whatever its hosts' states).
    w.set_status(S::STATUS_ENDED);
    let end = GENESIS + 200_000i64 * 600 + crate::proc::map::END_GRACE_SECS;
    crate::prologue::set_test_clock(end - 1, 9_000);
    assert_eq!(
        code(w.close_holding(coord, site, payer.clone())),
        Err(E::TooEarly as u32)
    );
    assert_eq!(
        code(w.close_transit(coord, site, 0, payer2.clone())),
        Err(E::TooEarly as u32)
    );
    assert_eq!(
        code(w.close_roster(coord, payer.clone())),
        Err(E::TooEarly as u32)
    );
    assert_eq!(
        code(w.close_province(coord, wedge)),
        Err(E::TooEarly as u32)
    );
    assert!(wide_records().is_empty(), "refusals log nothing");
    crate::prologue::set_test_clock(end, 9_001);
    // The holding: whole, the escrow included, to its rent payer.
    let holding_before = w.holding(coord, site).lamports();
    assert_eq!(
        Ro(&w.holding_data(coord, site)).u64(H::ESCROW).unwrap(),
        tip
    );
    let payer_before = payer.lamports();
    assert_eq!(code(w.close_holding(coord, site, payer.clone())), Ok(()));
    assert!(absent(&w.holding(coord, site)));
    assert_eq!(
        payer.lamports(),
        payer_before + holding_before,
        "the rent and the escrow, to the holding's rent payer"
    );
    // The transit record: to its own rent recipient; the holding position
    // is the closed account at its canonical address, so nothing is
    // counted down and nothing else is assumed about it.
    let p2 = payer2.lamports();
    assert_eq!(
        code(w.close_transit(coord, site, 0, payer.clone())),
        Err(E::BadAddress as u32),
        "the record's own rent recipient"
    );
    assert_eq!(
        code(w.close_transit(coord, site, 0, payer2.clone())),
        Ok(())
    );
    assert!(absent(&transit_ai));
    assert_eq!(payer2.lamports(), p2 + rent_t, "the record's rent, once");
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.host()), (WideKind::TransitClosed, Some(host)));
        assert_eq!((r.standing(), r.home_of()), (Some(key), Some(key)));
        assert_eq!(r.payload[0], 0);
        assert_eq!(&r.payload[1..33], &PAYER2);
        assert_eq!(&r.payload[33..41], &rent_t.to_le_bytes());
    }
    assert_eq!(
        code(w.close_transit(coord, site, 0, payer2.clone())),
        Err(E::BadAccount as u32),
        "closed"
    );
    // The roster over the pending `Spend`, the province present: the
    // entry's rights expired with the deadline; whole to the payer of the
    // muster that created the table, nothing credited.
    let rent_r = crate::init::rent(wro::wide_roster::SIZE).unwrap();
    assert_eq!(w.roster(coord).lamports(), rent_r);
    assert!(
        matches!(
            read_entry(&w.province_data(coord), 0).unwrap().op,
            EntryOp::Spend { .. }
        ),
        "the Spend is still pending"
    );
    let payer_before = payer.lamports();
    assert_eq!(
        code(w.close_roster(coord, payer2.clone())),
        Err(E::BadAddress as u32),
        "the immutable rent recipient"
    );
    assert_eq!(code(w.close_roster(coord, payer.clone())), Ok(()));
    assert!(absent(&w.roster(coord)));
    assert_eq!(payer.lamports(), payer_before + rent_r);
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.province()), (WideKind::RosterClosed, Some(key)));
        assert_eq!(&r.payload[..32], &PAYER);
        assert_eq!(&r.payload[32..40], &rent_r.to_le_bytes());
        assert_eq!(r.links, [None, None]);
    }
    assert_eq!(
        code(w.close_roster(coord, payer.clone())),
        Err(E::BadAccount as u32),
        "closed"
    );
    // The province into the fund of the wedge that opened it, the fund's
    // `provinces_opened` one fewer (the deployed CloseProvince); another
    // wedge's fund is refused; the entry table goes with the account.
    let fund = w.w.fund(wedge);
    let fund_before = fund.lamports();
    let opened_before = {
        let fd = fund.try_borrow_data().unwrap().to_vec();
        Ro(&fd).u32(PF::PROVINCES_OPENED).unwrap()
    };
    let prov_before = w.province(coord).lamports();
    assert_eq!(
        code(w.close_province(coord, (wedge + 1) % 6)),
        Err(E::BadAddress as u32),
        "another wedge's fund"
    );
    // the province's chain as it stands (the resolves and the muster
    // advanced it): the close's record is its terminal link
    let pchain = chain(&w.province(coord));
    assert!(pchain.0 > 0, "the province has a chain");
    assert_eq!(code(w.close_province(coord, wedge)), Ok(()));
    assert!(absent(&w.province(coord)));
    assert_eq!(fund.lamports(), fund_before + prov_before);
    {
        let fd = fund.try_borrow_data().unwrap().to_vec();
        assert_eq!(
            Ro(&fd).u32(PF::PROVINCES_OPENED).unwrap(),
            opened_before - 1
        );
    }
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!(
            (r.kind, r.province()),
            (WideKind::ProvinceClosed, Some(key))
        );
        assert_eq!(&r.payload[..32], &fund.key.to_bytes());
        assert_eq!(&r.payload[32..40], &prov_before.to_le_bytes());
        let link = r
            .link(wev::WideEntity::Province)
            .expect("the terminal link");
        assert_eq!(r.links, [Some(link), None], "the province link alone");
        assert_eq!(link.seq, pchain.0 + 1);
        assert_eq!(
            wev::verify_chain(
                wev::WideTarget::Province(key),
                pchain,
                std::iter::once(&wr[0][..])
            ),
            Ok((link.seq, link.head)),
            "the record continues the province's chain from the header it erased"
        );
    }
    assert_eq!(
        code(w.close_province(coord, wedge)),
        Err(E::BadAccount as u32),
        "closed"
    );
    assert!(records().is_empty(), "no PS2 record");

    // --- The other order the deployed closes allow: the province first,
    // its roster after it under the Closed tombstone (CloseSeason ran),
    // the province position the absent account at its canonical address.
    // **Fixture**: the destination's roster as a muster there would have
    // created it (a second wallet's rent), no reference live.
    let mut rb = vec![0u8; wro::wide_roster::SIZE];
    WideRoster::new(SEASON_ID, dkey, PAYER2)
        .write_header(&mut rb)
        .unwrap();
    let droster = w.roster(dest);
    restore(&droster, rent_r, &rb, Pubkey::new_from_array(PROGRAM));
    let dfund = w.w.fund(dwedge);
    let dfund_before = dfund.lamports();
    let dprov_before = w.province(dest).lamports();
    assert_eq!(code(w.close_province(dest, dwedge)), Ok(()));
    assert!(absent(&w.province(dest)));
    assert_eq!(dfund.lamports(), dfund_before + dprov_before);
    assert_eq!(wide_records().len(), 1);
    let tomb = w.tombstone();
    assert_eq!(
        code(w.close_province_under(dest, dwedge, tomb.clone())),
        Err(E::BadAccount as u32),
        "no province close under the tombstone: CloseSeason closed the funds, as deployed"
    );
    let p2 = payer2.lamports();
    assert_eq!(
        code(w.close_roster_under(dest, payer.clone(), tomb.clone())),
        Err(E::BadAddress as u32),
        "the immutable rent recipient, under the tombstone too"
    );
    assert_eq!(
        code(w.close_roster_under(dest, payer2.clone(), tomb.clone())),
        Ok(()),
        "the tombstone and the absent province"
    );
    assert!(absent(&droster));
    assert_eq!(payer2.lamports(), p2 + rent_r, "the table's rent, once");
    let wr = wide_records();
    assert_eq!(wr.len(), 1);
    {
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!((r.kind, r.province()), (WideKind::RosterClosed, Some(dkey)));
        assert_eq!(r.bell, frontier_abi::log::NO_BELL);
        assert_eq!(&r.payload[..32], &PAYER2);
        assert_eq!(&r.payload[32..40], &rent_r.to_le_bytes());
    }
    assert_eq!(
        code(w.close_roster_under(dest, payer2.clone(), tomb.clone())),
        Err(E::BadAccount as u32),
        "closed"
    );
    // Under the tombstone with THE anchor **present** and listed: the
    // season-end fallback closes the unsettled slot without reading the
    // anchor or the Season's clock (the tombstone has none), as the
    // deployed close's short-circuit does.
    let p2 = payer2.lamports();
    assert_eq!(
        code(w.close_slot_under(dest, bell, f, 1, payer2.clone(), Some(anchor), tomb)),
        Ok(()),
        "the tombstone and a present anchor"
    );
    assert!(absent(&slot1_ai));
    assert_eq!(payer2.lamports(), p2 + rent_s);
    {
        let wr = wide_records();
        assert_eq!(wr.len(), 1);
        let r = WideRecord::decode(&wr[0]).unwrap();
        assert_eq!(
            (r.kind, r.bell),
            (WideKind::RecordClosed, frontier_abi::log::NO_BELL)
        );
        assert_eq!((r.payload[0], r.payload[6]), (wix::CLOSE_WHAT_SLOT, 1));
        assert_eq!(&r.payload[39..47], &rent_s.to_le_bytes());
    }
    assert!(records().is_empty() && wide_records().is_empty());
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
/// plus 72 h) a Settled record closes in CloseCitizen's shape **before** its
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
