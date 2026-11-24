//! VWL — the WIDE LAND opening of a PLAYABLE-lane season (program version
//! 0x4804, `playable-lane` build only; Q16-1 = A, 2026-11-18): the four
//! wide instructions that make land past the legacy disk, each re-run from
//! the states the archive shows before it and compared byte for byte with
//! what it wrote. The program's handlers are `permutation-frontier`
//! `proc/wide.rs` (`set_rules`, `request_ring_seed`, `consume_ring_seed`,
//! `open_province`); the rules are the shared kernels the handlers call
//! (`frontier_abi::world_index::{land, rules}`,
//! `permutation_rules::frontier::{beacon, terrain::wide, keep}`), in the
//! handlers' check order:
//!
//! * **WideSetRules (0xDB)** `[authority] [season] [rules_config w]
//!   [system]`: the Season this season's, Seeded or Running at the
//!   transaction's time, of this build's version; the authority account is
//!   the Season's stored `AUTHORITY`; the configuration at its canonical
//!   address and absent before (write-once); `config_version` current; the
//!   keep-holder candidate one the Season's `placement` allows
//!   (`rules::keep_holder_allowed`: placement 2 takes MixedInterleaved
//!   only); the record written = `WideRulesConfig::new(season, world, authority,
//!   bytes)`.
//! * **WideRequestRingSeed (0xD6)** `[payer] [season] [frontier]
//!   [previous] [target w] [pfund ×6] [system]`: Running; ring ≥ 129; the
//!   Frontier present; the previous ring's seed read-only (ring 129: the
//!   legacy RingSeed of ring 128 at its address with `d = 128`; else the
//!   wide seed of `ring − 1`), the target absent at its address; the
//!   record = `WideRingSeed::request` (previous seeded, a bell since it
//!   opened, the round `ring_seed_round(now)`); θ on the Frontier's folded
//!   wedge counters (θ early/late by `now − genesis_ts`); every wedge fund
//!   present at its address and above its rent by `ring × rent(wide
//!   province)`. The rent is the chain's: VWL reads its per-byte rate from
//!   the record the instruction created (rent-exempt at exactly
//!   `(128 + size) × rate`); a record that is not at an exact rate leaves
//!   the fund gate `MissingData`.
//! * **WideConsumeRingSeed (0xD7)** `[fee_payer] [season] [target w]`:
//!   Seeded or Running; the record present at its address, of this ring
//!   and world, still requested; `round == record.round`; the round's
//!   signature verifies against the configured quicknet key (the verifier's
//!   own BLS check, not the program's); the record written =
//!   `seed_with(round, seed_of(round, sig))`.
//! * **WideOpenProvince (0xD8)** `[payer] [season] [ringseed w] [pfund w]
//!   [province w] [rules_config] [system]`: Seeded or Running; a canonical
//!   coordinate of ring ≥ 129; its ring's seed seeded, of this world; the
//!   coordinate's wedge fund present; the province absent at its address;
//!   the configuration present (without one the program refuses before
//!   any write); the whole province re-made: `generate_province_wide` over
//!   the ring seed in the program's terrain encoding, `resolved_next =
//!   score_next_bell = now_bell`, every site free and neutral, the keep
//!   (`keep_tile_symmetric`, `wide_keep_open` with the Season's keep
//!   parameters), the configured Free City (the Season's garrison) and
//!   camp, `next_check_day`, the identity trailer; the fund's counters
//!   (`open_sites`, `provinces_opened`, `provinces_funded`, `spent_total`)
//!   moved by exactly the site count, one, one and the lamports the fund
//!   paid, which is also the province's `funded_lamports`; the ring seed's
//!   `provinces_created + 1`.
//!
//! Every instruction must also leave every other program account of its
//! transaction unchanged (each handler writes only the accounts above).
//!
//! What VWL does **not** prove: signatures (the runtime's), the payer's
//! lamports, the rent of a created record beyond the per-byte rate above,
//! and anything common to the program and the shared kernels (as V7 and
//! VL). A wide land instruction that shares its transaction with another
//! program instruction is `MissingData` (no state between the two). The
//! wide claims (WideClaimSite, WideSettleTicket, WideFinalize) are VWL's
//! too, in `vwl_wide_claims.rs` (2026-11-19), and so are the season-end
//! WideCloses of a ticket record, a holding and a province
//! (`vwl_wide_close.rs`), the wide economy and garrison
//! (`vwl_wide_economy.rs`), and WideMuster and WideResolve, the bell with
//! the wide keep capture (`vwl_wide_march.rs`), and player territory
//! (#209: WideClaimTile, WideTerritorySettle, WideTerritoryDecay,
//! WideTerritoryConquer, `vwl_wide_territory.rs`; the keeper's
//! multi-instruction territory transactions are re-run whole, the one
//! exception to the rule above). WideDissolve, WideReturn,
//! WideCloseRoster and WideDisbandStranded are VX's (re-executed by the
//! pinned program, verifier-coverage), a successful WideResidentAct is a V0
//! FAIL in this lane; since verifier-coverage-2 every other decodable wide
//! command is VX's (`vx_reexec::native_of`), and the ones the pinned
//! devnet-playable binary can never run are a V0 FAIL (`GateClosed`).
//!
//! Lamports: the archive holds program transactions only, and anyone can
//! send lamports to any account by a plain system transfer, so an archived
//! balance before is a lower bound. A program account holding MORE than
//! the re-run says is `MissingData`, fewer is a FAIL; the wedge fund's
//! spend is read from its `spent_total` (data moves by program
//! instructions only).
//!
//! Codes: `Undecodable`, `WideAccounts`, `WideRule`, `WideReplayMismatch`,
//! `MissingData`.

use std::collections::BTreeMap;

use fclient::ports::Account;
use frontier_abi::addr::{day_of, AddrCtx};
use frontier_abi::layout::province::{camp as CP, province as PV, site as SM};
use frontier_abi::layout::world::{
    frontier as FR, province_fund as PF, ring_seed as RS, season as S,
};
use frontier_abi::layout::AccountKind;
use frontier_abi::prologue::AccountView;
use frontier_abi::v2::layout::province::{province as PV2, site as SM2};
use frontier_abi::v2::presets::{ConquestParams, RULESET_HASH_V3};
use frontier_abi::world_index::land::{self as wl, PreviousRing, WideProvince, WideRingSeed};
use frontier_abi::world_index::rules::{self as wr, OpeningInput, WideRulesConfig};
use frontier_abi::world_index::wide_ix::{self as wix, WideCommand};
use frontier_abi::world_index::{WideCoord, WorldId};
use permutation_rules::fixed::{BPS_ONE, MILLI};
use permutation_rules::frontier::beacon::BeaconClock;
use permutation_rules::frontier::clash::NEUTRAL;
use permutation_rules::frontier::geometry::R_MAX_HARD;
use permutation_rules::frontier::holding::Tier;
use permutation_rules::frontier::keep::NO_KEEP_TILE;
use permutation_rules::frontier::terrain::wide::generate_province_wide;

use super::Ctx;
use crate::codes::*;
use crate::facts::SigCache;
use crate::input::Input;
use crate::world::{b58, Ix, Key, World};
use crate::{Finding, Severity};

pub const V: &str = "VWL";
const SYSTEM: Key = [0; 32];
/// The Season states the wide land handlers accept (`proc::map::LAND_STATUS`).
const LAND_STATUS: [u8; 2] = [S::STATUS_SEEDED, S::STATUS_RUNNING];

/// Why one instruction is not the program's.
#[derive(Debug)]
pub enum Wrong {
    /// The program's rules refuse it: a FAIL.
    Fail(&'static str, String),
    /// The archive lacks a state the re-run needs.
    Missing(String),
}
use Wrong::*;

fn fail(c: &'static str, d: impl Into<String>) -> Wrong {
    Fail(c, d.into())
}

/// The wide land commands VWL re-judges (V0 leaves them to it).
pub fn judged(data: &[u8]) -> Option<&'static str> {
    match WideCommand::decode(data).ok()? {
        WideCommand::SetRules(_) => Some("WideSetRules"),
        WideCommand::RequestRingSeed(_) => Some("WideRequestRingSeed"),
        WideCommand::ConsumeRingSeed(_) => Some("WideConsumeRingSeed"),
        WideCommand::OpenProvince(_) => Some("WideOpenProvince"),
        c => territory::judged(&c).or_else(|| claims::judged(&c)),
    }
}

#[path = "vwl_wide_claims.rs"]
mod claims;
#[path = "vwl_wide_close.rs"]
mod close;
#[path = "vwl_wide_economy.rs"]
mod economy;
#[path = "vwl_wide_march.rs"]
mod march;
#[path = "vwl_wide_territory.rs"]
mod territory;

/// The states one instruction is judged from.
struct Env<'a> {
    w: &'a World,
    /// The archive's records, in `w.txs` order (the logs: the wide economy
    /// reads the record a transaction printed).
    recs: &'a [fclient::ports::TxRecord],
    /// An execution witness (the segment's pre-states), consulted for an
    /// account no earlier transaction of the archive wrote.
    snapshot: Option<&'a BTreeMap<Key, Option<Account>>>,
    /// A recorder's declared patches (`Input::declared`): a state set
    /// between two transactions that no archived transaction wrote
    /// (verifier-coverage: VWL read the last archived post-state instead,
    /// and FAILed an honest recording whose later patch it did not see).
    declared: &'a [crate::input::Declared],
    /// Whether the judgement read a declared state (then it is never a
    /// PASS: `MissingData` when nothing else is wrong, as VX rules).
    read_declared: std::cell::Cell<bool>,
    ctx: AddrCtx,
    sid: u64,
    tx: usize,
    now: i64,
    quicknet_pk: [u8; 96],
}

impl Env<'_> {
    /// The account before the transaction (`None`: absent).
    fn acct_before(&self, k: &Key) -> Option<Account> {
        let posted = self.w.posts.get(k).and_then(|v| {
            let i = v.partition_point(|&t| t < self.tx);
            i.checked_sub(1).and_then(|i| v.get(i)).copied()
        });
        // the last declared patch in force before this transaction, when it
        // is later than the last archived write (`vx_reexec::before`)
        let decl = self
            .declared
            .iter()
            .rfind(|d| d.key == *k && d.at <= self.tx)
            .filter(|d| posted.is_none_or(|t| d.at > t));
        if let Some(d) = decl {
            self.read_declared.set(true);
            return d.account.clone();
        }
        if let Some(t) = posted {
            return self.w.txs[t].post.get(k).cloned().flatten();
        }
        self.snapshot.and_then(|s| s.get(k).cloned().flatten())
    }
    /// Whether the archive (or the witness) has any state of `k` before the
    /// transaction, absent included.
    fn known_before(&self, k: &Key) -> bool {
        self.w
            .posts
            .get(k)
            .is_some_and(|v| v.partition_point(|&t| t < self.tx) > 0)
            || self.declared.iter().any(|d| d.key == *k && d.at <= self.tx)
            || self.snapshot.is_some_and(|s| s.contains_key(k))
    }
    fn before(&self, k: &Key, what: &str) -> Result<Account, Wrong> {
        let a = self
            .acct_before(k)
            .ok_or_else(|| Missing(format!("{what}: the archive has no state before")))?;
        // A real archive also holds wallets: a state this check reads as
        // the program's must be program-owned (`view` says so to the
        // shared prologue).
        if a.owner.to_bytes() != self.ctx.program {
            return Err(fail(
                WIDE_ACCOUNTS,
                format!("{what} is not owned by the program"),
            ));
        }
        Ok(a)
    }
    fn after(&self, k: &Key, what: &str) -> Result<Account, Wrong> {
        self.w.txs[self.tx]
            .post
            .get(k)
            .cloned()
            .flatten()
            .ok_or_else(|| Missing(format!("{what}: the archive has no post-state")))
    }
    fn view<'b>(&'b self, k: &'b Key, d: &'b [u8]) -> AccountView<'b> {
        AccountView {
            key: k,
            owner: &self.ctx.program,
            lamports: 1,
            data: d,
            is_signer: false,
            is_writable: false,
        }
    }
    /// The program's `prologue::season`: this season's Season (its PDA),
    /// the allowed effective status at `now`, the S1 ruleset; then
    /// `require_wide_season` (this build's version, with the wide bit).
    fn season(&self, ix: &Ix, allowed: &[u8]) -> Result<Vec<u8>, Wrong> {
        self.season_at(ix, 1, allowed)
    }
    /// [`Env::season`] for a Season at account position `at`.
    fn season_at(&self, ix: &Ix, at: usize, allowed: &[u8]) -> Result<Vec<u8>, Wrong> {
        let k = ix
            .key(at)
            .ok_or_else(|| fail(UNDECODABLE, "no Season account"))?;
        if k != self.ctx.season {
            return Err(fail(
                WIDE_ACCOUNTS,
                format!("account {at} is not this season's Season"),
            ));
        }
        let d = self.before(&k, "the Season")?.data;
        frontier_abi::prologue::check_season(
            &self.view(&k, &d),
            &self.ctx.program,
            Some(&RULESET_HASH_V3),
            allowed,
            self.now,
        )
        .map_err(|e| {
            fail(
                WIDE_ACCOUNTS,
                format!("the Season is not this program's S1-ruleset Season in an allowed state at the transaction's time ({e:?})"),
            )
        })?;
        let v = le(&d, S::PROGRAM_VERSION, 2) as u16;
        if v != super::v0_coverage::PROGRAM_VERSION_PLAYABLE {
            return Err(fail(
                WIDE_ACCOUNTS,
                format!("the Season's program version is {v:#06x}, not the playable build's"),
            ));
        }
        Ok(d)
    }
    fn present(&self, k: &Key, d: &[u8], kind: AccountKind) -> bool {
        frontier_abi::prologue::check_present(&self.view(k, d), &self.ctx.program, kind, self.sid)
            .is_ok()
    }
    /// A legacy account of `kind` present before at exactly `addr`.
    fn legacy(&self, k: &Key, addr: &Key, kind: AccountKind, what: &str) -> Result<Account, Wrong> {
        if k != addr {
            return Err(fail(WIDE_ACCOUNTS, format!("{what} is not at its address")));
        }
        let a = self.before(k, what)?;
        if !self.present(k, &a.data, kind) {
            return Err(fail(
                WIDE_ACCOUNTS,
                format!("{what} is not a {kind:?} of this season"),
            ));
        }
        Ok(a)
    }
    /// Absent before: the archive shows no program state of `k` before.
    fn absent(&self, k: &Key, what: &str) -> Result<(), Wrong> {
        if self.acct_before(k).is_some_and(|a| !a.data.is_empty()) {
            return Err(fail(
                WIDE_RULE,
                format!("{what} already existed (the program refuses AlreadyDone)"),
            ));
        }
        Ok(())
    }
    fn world(&self) -> Result<WorldId, Wrong> {
        WorldId::derive_legacy_season(&self.ctx.season, &self.ctx.program)
            .map_err(|e| fail(WIDE_ACCOUNTS, format!("the world id: {e:?}")))
    }
    fn bell(&self, season: &[u8]) -> u32 {
        frontier_abi::prologue::bell_at(le(season, S::GENESIS_TS, 8) as i64, self.now).unwrap_or(0)
    }
}

fn le(d: &[u8], o: usize, n: usize) -> u64 {
    crate::world::le(d.get(o..o + n).unwrap_or(&[]))
}

fn u32x6(d: &[u8], o: usize) -> [u32; 6] {
    core::array::from_fn(|i| le(d, o + 4 * i, 4) as u32)
}

fn wr_u32(d: &mut [u8], o: usize, v: u32) {
    d[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

fn wr_u64(d: &mut [u8], o: usize, v: u64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}

fn first_diff(a: &[u8], b: &[u8]) -> String {
    match a.iter().zip(b).position(|(x, y)| x != y) {
        Some(i) => format!("first differing byte {i}"),
        None => format!("{} vs {} bytes", a.len(), b.len()),
    }
}

/// The written account `k` must be `want` byte for byte, program-owned.
fn expect_after(e: &Env, k: &Key, want: &[u8], what: &str) -> Result<Account, Wrong> {
    let got = e.after(k, what)?;
    if got.owner.to_bytes() != e.ctx.program {
        return Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!("{what} is not owned by the program after"),
        ));
    }
    if got.data != want {
        return Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "{what} is not the re-run's ({})",
                first_diff(&got.data, want)
            ),
        ));
    }
    Ok(got)
}

/// `ring_occupancy_met` (`proc/map.rs`): some wedge with open sites at θ.
fn occupancy_met(occ: &[u32; 6], open: &[u32; 6], theta_bps: u16) -> bool {
    (0..6)
        .any(|w| open[w] > 0 && occ[w] as u64 * BPS_ONE as u64 >= theta_bps as u64 * open[w] as u64)
}

/// Rent-exempt minimum at `rate` lamports per byte (Rent's
/// `(ACCOUNT_STORAGE_OVERHEAD + size) × lamports_per_byte_year × 2`).
fn rent_at(rate: u64, size: usize) -> Option<u64> {
    rate.checked_mul(128 + size as u64)
}

fn n_accounts(ix: &Ix, n: usize, name: &str) -> Result<(), Wrong> {
    if ix.accounts.len() != n {
        return Err(fail(
            UNDECODABLE,
            format!(
                "{name} with {} accounts (the program takes {n})",
                ix.accounts.len()
            ),
        ));
    }
    Ok(())
}

fn writable(ix: &Ix, i: usize, what: &str, w: bool) -> Result<(), Wrong> {
    if ix.accounts[i].1 != w {
        return Err(fail(
            WIDE_ACCOUNTS,
            format!(
                "{what} is {}writable (the program requires {})",
                if ix.accounts[i].1 { "" } else { "not " },
                if w { "writable" } else { "read-only" }
            ),
        ));
    }
    Ok(())
}

// ------------------------------------------------------------ 0xDB

fn set_rules(e: &Env, ix: &Ix, x: &wix::SetRules) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 4, "WideSetRules")?;
    let sd = e.season(ix, &LAND_STATUS)?;
    let (authority, config) = (ix.accounts[0].0, ix.accounts[2].0);
    if ix.accounts[3].0 != SYSTEM {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the fourth account is not the system program",
        ));
    }
    let stored: [u8; 32] = sd[S::AUTHORITY..S::AUTHORITY + 32].try_into().unwrap();
    if authority != stored {
        return Err(fail(
            WIDE_RULE,
            "the signer is not the Season's authority (the program refuses Auth)",
        ));
    }
    let world = e.world()?;
    if config != wr::rules_config_address(&e.ctx) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the configuration is not at its address",
        ));
    }
    writable(ix, 2, "the configuration", true)?;
    e.absent(&config, "the configuration")?;
    // The program build that made the archive took ITS table's version
    // only: v2 for the deployed playable-lane programs (da3dc1aa, 67a33c92),
    // v3 from #209 (player territory) on. An archive is judged against the
    // table its record names, so any known table is taken, and a rule byte
    // outside that table is refused below (verify-pr206-209: the v3 bump
    // made every recorded v2 archive a false FAIL).
    if ![
        wr::WIDE_RULES_CONFIG_VERSION,
        wr::WIDE_RULES_CONFIG_VERSION_V2,
        wr::WIDE_RULES_CONFIG_VERSION_V1,
    ]
    .contains(&x.config_version)
    {
        return Err(fail(
            WIDE_RULE,
            format!("config_version {} is not a known table", x.config_version),
        ));
    }
    // ⑧ wide land (i) (#38, `proc/wide.rs` `set_rules`): a Season whose
    // disk keeps are mixed on every ring (`placement` 2) takes the same
    // keep-holder function past ring 128; any other candidate is refused
    // `BadData` (D-verify-pr72-9).
    let placement = ConquestParams::of_season(&sd)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Season's conquest block does not decode"))?
        .placement;
    let holder = wr::KeepHolderRule::from_byte(x.keep_holder).map_err(|er| {
        fail(
            WIDE_RULE,
            format!("a keep-holder byte the program refuses ({er:?})"),
        )
    })?;
    if !holder.in_table(x.config_version) {
        return Err(fail(
            WIDE_RULE,
            format!(
                "keep-holder rule {holder:?} is not in table {} (the program refuses it)",
                x.config_version
            ),
        ));
    }
    if !wr::keep_holder_allowed(placement, holder) {
        return Err(fail(
            WIDE_RULE,
            format!(
                "keep-holder rule {holder:?} is not allowed under the Season's placement {placement} (the program refuses BadData)"
            ),
        ));
    }
    // ⑧ (d) (#69, `proc/wide.rs` `set_rules`): under placement 2 a wide
    // Free City is the deployed kernel's (`DeployedLe32V1`) or none; the
    // different wide formula `CanonicalHashV1` is refused `BadData`.
    let free_city = wr::FreeCityRule::from_byte(x.free_city).map_err(|er| {
        fail(
            WIDE_RULE,
            format!("a Free City byte the program refuses ({er:?})"),
        )
    })?;
    if !free_city.in_table(x.config_version) {
        return Err(fail(
            WIDE_RULE,
            format!(
                "Free City rule {free_city:?} is not in table {} (the program refuses it)",
                x.config_version
            ),
        ));
    }
    if !wr::free_city_allowed(placement, free_city) {
        return Err(fail(
            WIDE_RULE,
            format!(
                "Free City rule {free_city:?} is not allowed under the Season's placement {placement} (the program refuses BadData)"
            ),
        ));
    }
    let mut rec = WideRulesConfig::new(
        e.sid,
        world,
        authority,
        wr::RuleBytes {
            keep_holder: x.keep_holder,
            free_city: x.free_city,
            camp: x.camp,
            region: x.region,
        },
    )
    .map_err(|er| {
        fail(
            WIDE_RULE,
            format!("a rule byte the program refuses ({er:?})"),
        )
    })?;
    rec.config_version = x.config_version;
    let mut want = vec![0u8; wr::rules_config::SIZE];
    rec.write(&mut want)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the configuration's bytes: {er:?}")))?;
    expect_after(e, &config, &want, "the configuration")?;
    Ok(vec![(config, Lam::Created)])
}

// ------------------------------------------------------------ 0xD6

fn request_ring_seed(e: &Env, ix: &Ix, x: &wix::RequestRingSeed) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 12, "WideRequestRingSeed")?;
    let sd = e.season(ix, &[S::STATUS_RUNNING])?;
    if x.ring < wl::FIRST_WIDE_RING {
        return Err(fail(
            WIDE_RULE,
            format!("ring {} is not past the disk", x.ring),
        ));
    }
    let world = e.world()?;
    let k = |i: usize| ix.accounts[i].0;
    let fd = e
        .legacy(
            &k(2),
            &e.ctx.frontier(),
            AccountKind::Frontier,
            "the Frontier",
        )?
        .data;
    writable(ix, 3, "the previous ring's seed", false)?;
    let prev = if x.ring == wl::FIRST_WIDE_RING {
        let a = e.legacy(
            &k(3),
            &e.ctx.ring_seed(R_MAX_HARD),
            AccountKind::RingSeed,
            "the legacy RingSeed of ring 128",
        )?;
        if le(&a.data, RS::D, 2) as u16 != R_MAX_HARD {
            return Err(fail(WIDE_ACCOUNTS, "the legacy RingSeed is not ring 128's"));
        }
        PreviousRing {
            ring: R_MAX_HARD as u64,
            seeded: a.data[RS::STATUS] == RS::STATUS_SEEDED,
            opened_bell: le(&a.data, RS::OPENED_BELL, 4) as u32,
        }
    } else {
        if k(3) != wl::ring_seed_address(&e.ctx, x.ring - 1) {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the previous ring's seed is not at its address",
            ));
        }
        let a = e.acct_before(&k(3)).ok_or_else(|| {
            if e.known_before(&k(3)) {
                fail(
                    WIDE_RULE,
                    "the previous ring's seed is absent (the program refuses TooEarly)",
                )
            } else {
                Missing("the previous ring's seed: the archive has no state before".into())
            }
        })?;
        if a.owner.to_bytes() != e.ctx.program {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the previous ring's seed is not owned by the program",
            ));
        }
        let rec = WideRingSeed::read(&a.data)
            .map_err(|er| fail(WIDE_ACCOUNTS, format!("the previous ring's seed: {er:?}")))?;
        if rec.season_id != e.sid || rec.ring != x.ring - 1 || rec.world != world {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the previous ring's seed is of another season, ring or world",
            ));
        }
        PreviousRing {
            ring: rec.ring,
            seeded: rec.status == wl::SeedStatus::Seeded,
            opened_bell: rec.opened_bell,
        }
    };
    let target = k(4);
    if target != wl::ring_seed_address(&e.ctx, x.ring) {
        return Err(fail(WIDE_ACCOUNTS, "the ring seed is not at its address"));
    }
    writable(ix, 4, "the ring seed", true)?;
    e.absent(&target, "the ring seed")?;
    let clock = BeaconClock {
        genesis: le(&sd, S::DRAND_GENESIS, 8) as i64,
        period: le(&sd, S::DRAND_PERIOD, 4) as i64,
    };
    let rec = WideRingSeed::request(
        world,
        e.sid,
        x.ring,
        prev,
        e.bell(&sd),
        e.now,
        &clock,
        le(&sd, S::SEED_MARGIN, 4) as u32,
        k(0),
    )
    .map_err(|er| {
        fail(
            WIDE_RULE,
            format!("the ring model refuses the request ({er:?})"),
        )
    })?;
    let genesis_ts = le(&sd, S::GENESIS_TS, 8) as i64;
    let theta = if e.now.saturating_sub(genesis_ts) < le(&sd, S::THETA_SWITCH_SECS, 4) as i64 {
        le(&sd, S::THETA_EARLY_BPS, 2) as u16
    } else {
        le(&sd, S::THETA_LATE_BPS, 2) as u16
    };
    if !occupancy_met(
        &u32x6(&fd, FR::WEDGE_OCCUPIED),
        &u32x6(&fd, FR::WEDGE_OPEN),
        theta,
    ) {
        return Err(fail(
            WIDE_RULE,
            format!("no wedge is at θ = {theta} bps occupancy on the Frontier (the program refuses Capacity)"),
        ));
    }
    let mut want = vec![0u8; wl::ring_seed::SIZE];
    rec.write(&mut want)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ring seed's bytes: {er:?}")))?;
    let created = expect_after(e, &target, &want, "the ring seed")?;
    // The fund gate, at the chain's rent (read from the created record).
    let base = 128 + wl::ring_seed::SIZE as u64;
    let rate = (created.lamports % base == 0).then_some(created.lamports / base);
    for w in 0..6u8 {
        let f = k(5 + w as usize);
        let a = e.legacy(
            &f,
            &e.ctx.province_fund(w),
            AccountKind::ProvinceFund,
            "a wedge fund",
        )?;
        let Some(rate) = rate else {
            return Err(Missing(format!(
                "the fund gate: the created ring seed holds {} lamports, not a rent-exempt minimum the verifier can read the chain's rent from",
                created.lamports
            )));
        };
        let need = rent_at(rate, wl::province::SIZE)
            .and_then(|r| wl::ring_rent(x.ring, r))
            .ok_or_else(|| fail(WIDE_RULE, "the fund cover overflows"))?;
        let fund_rent = rent_at(rate, PF::SIZE).unwrap_or(u64::MAX);
        if a.lamports.saturating_sub(fund_rent) < need {
            return Err(fail(
                WIDE_RULE,
                format!("wedge fund {w} holds {} lamports, below its rent + {need} (the program refuses Insufficient)", a.lamports),
            ));
        }
    }
    if k(11) != SYSTEM {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the last account is not the system program",
        ));
    }
    Ok(vec![(target, Lam::Checked)])
}

// ------------------------------------------------------------ 0xD7

fn consume_ring_seed(
    e: &Env,
    ix: &Ix,
    x: &wix::ConsumeRingSeed,
    sigs: &mut SigCache,
) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 3, "WideConsumeRingSeed")?;
    e.season(ix, &LAND_STATUS)?;
    let world = e.world()?;
    let target = ix.accounts[2].0;
    if target != wl::ring_seed_address(&e.ctx, x.ring) {
        return Err(fail(WIDE_ACCOUNTS, "the ring seed is not at its address"));
    }
    writable(ix, 2, "the ring seed", true)?;
    let a = e.before(&target, "the ring seed")?;
    let rec = WideRingSeed::read(&a.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ring seed: {er:?}")))?;
    if rec.season_id != e.sid || rec.ring != x.ring || rec.world != world {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ring seed is of another season, ring or world",
        ));
    }
    if rec.status == wl::SeedStatus::Seeded {
        return Err(fail(
            WIDE_RULE,
            "the ring seed was already seeded (the program refuses AlreadyDone)",
        ));
    }
    if x.round != rec.round {
        return Err(fail(
            WIDE_RULE,
            format!(
                "round {} is not the record's bound round {} (the program refuses WrongRound)",
                x.round, rec.round
            ),
        ));
    }
    if !sigs.ok(x.round, &x.sig48, &e.quicknet_pk) {
        return Err(fail(
            BEACON_SIG_INVALID,
            format!(
                "the signature of round {} does not verify against the quicknet key",
                x.round
            ),
        ));
    }
    let seed = super::v3_random::seed_of48(x.round, &x.sig48)
        .ok_or_else(|| fail(BEACON_SIG_INVALID, "the signature does not decompress"))?;
    let seeded = rec.seed_with(x.round, seed).map_err(|er| {
        fail(
            WIDE_RULE,
            format!("the ring model refuses the seed ({er:?})"),
        )
    })?;
    let mut want = vec![0u8; wl::ring_seed::SIZE];
    seeded
        .write(&mut want)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ring seed's bytes: {er:?}")))?;
    expect_after(e, &target, &want, "the ring seed")?;
    Ok(vec![(target, Lam::Same)])
}

// ------------------------------------------------------------ 0xD8

fn open_province(e: &Env, ix: &Ix, x: &wix::OpenProvince) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 7, "WideOpenProvince")?;
    let sd = e.season(ix, &LAND_STATUS)?;
    let coord = WideCoord::checked(x.p, x.q).map_err(|er| {
        fail(
            WIDE_RULE,
            format!("({}, {}) is not a canonical coordinate ({er:?})", x.p, x.q),
        )
    })?;
    let ring = coord.ring();
    if ring < wl::FIRST_WIDE_RING {
        return Err(fail(WIDE_RULE, format!("ring {ring} is not past the disk")));
    }
    let world = e.world()?;
    let k = |i: usize| ix.accounts[i].0;
    if k(2) != wl::ring_seed_address(&e.ctx, ring) {
        return Err(fail(WIDE_ACCOUNTS, "the ring seed is not at its address"));
    }
    writable(ix, 2, "the ring seed", true)?;
    let seed_acc = e.before(&k(2), "the ring seed")?;
    let seed = WideRingSeed::read(&seed_acc.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ring seed: {er:?}")))?;
    if seed.season_id != e.sid || seed.ring != ring || seed.world != world {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ring seed is of another season, ring or world",
        ));
    }
    let ring_seed = *seed.terrain_seed().ok_or_else(|| {
        fail(
            WIDE_RULE,
            "the ring seed is not seeded (the program refuses SeedNotReady)",
        )
    })?;
    let wedge = coord
        .wedge()
        .ok_or_else(|| fail(WIDE_RULE, "the coordinate has no wedge"))?;
    let fund_before = e.legacy(
        &k(3),
        &e.ctx.province_fund(wedge),
        AccountKind::ProvinceFund,
        "the wedge fund",
    )?;
    writable(ix, 3, "the wedge fund", true)?;
    let target = k(4);
    if target != wl::province_address(&e.ctx, coord) {
        return Err(fail(WIDE_ACCOUNTS, "the province is not at its address"));
    }
    writable(ix, 4, "the province", true)?;
    e.absent(&target, "the province")?;
    writable(ix, 5, "the configuration", false)?;
    if k(5) != wr::rules_config_address(&e.ctx) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the configuration is not at its address",
        ));
    }
    if k(6) != SYSTEM {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the last account is not the system program",
        ));
    }
    let cfg = match e.acct_before(&k(5)) {
        Some(a) if a.owner.to_bytes() != e.ctx.program => {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the configuration is not owned by the program",
            ));
        }
        Some(a) => {
            let c = WideRulesConfig::read(&a.data)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the configuration: {er:?}")))?;
            if c.season_id != e.sid || c.world != world {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the configuration is of another season or world",
                ));
            }
            c
        }
        None if e.known_before(&k(5)) || e.snapshot.is_none() && e.w.has_post => {
            return Err(fail(
                WIDE_RULE,
                "no rules configuration exists, yet the province opened (the program refuses NotImplemented)",
            ));
        }
        None => {
            return Err(Missing(
                "the configuration: the archive has no state before".into(),
            ))
        }
    };
    let now_bell = e.bell(&sd);
    let cq = ConquestParams::of_season(&sd)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Season's conquest block does not decode"))?;
    let genesis_seed: [u8; 32] = sd[S::GENESIS_SEED..S::GENESIS_SEED + 32]
        .try_into()
        .unwrap();
    let terrain = generate_province_wide(&ring_seed, coord.p(), coord.q()).map_err(|er| {
        fail(
            WIDE_RULE,
            format!("the wide terrain kernel refuses ({er:?})"),
        )
    })?;
    let day = day_of(now_bell);
    let keep_tile = frontier_abi::v2::kernel::keep::keep_tile(
        &terrain,
        &terrain.sites,
        terrain.site_count,
        wedge,
    )
    .unwrap_or(NO_KEEP_TILE);
    let rules = cfg
        .decide(&OpeningInput {
            coord,
            genesis_seed: &genesis_seed,
            ring_seed: &ring_seed,
            terrain: &terrain,
            day,
            keep_tile: (keep_tile != NO_KEEP_TILE).then_some(keep_tile),
            free_cities: cq.free_city_min_ring != 0,
        })
        .map_err(|er| {
            fail(
                WIDE_RULE,
                format!("the configuration decides nothing ({er:?})"),
            )
        })?;
    let mut opening =
        WideProvince::open(world, e.sid, coord, &seed, &rules, now_bell, 0).map_err(|er| {
            fail(
                WIDE_RULE,
                format!("the land model refuses the opening ({er:?})"),
            )
        })?;
    // (devnet-territory-dev, as `proc/wide.rs open_province` since #209 E-Q1: the new-world bundle's neutral keeps
    //  open weaker, `KeepHolderRule::keep_guard`; before, every opening of a NeutralTerritoryV1 world read
    //  WideReplayMismatch at the keep's troops)
    let mut keep_prm = cq.keep_params();
    keep_prm.home_guard = cfg.keep_holder.keep_guard(keep_prm.home_guard);
    let keep = wr::wide_keep_open(opening.keep_holder, keep_tile, &keep_prm, now_bell)
        .map_err(|er| fail(WIDE_RULE, format!("the keep kernel refuses ({er:?})")))?;
    let garrison_milli = cq
        .free_city_garrison
        .checked_mul(MILLI as u32)
        .ok_or_else(|| fail(WIDE_RULE, "the Free City garrison overflows"))?;
    let counted = seed
        .with_province_created()
        .map_err(|er| fail(WIDE_RULE, format!("the ring seed's count ({er:?})")))?;
    // What the fund paid. Its data moves only by program instructions,
    // so `spent_total`'s delta is the amount; its lamports may also have
    // received system transfers the archive (program transactions only)
    // never shows, so the archived balance before is a lower bound: a
    // smaller drop than the amount is unknown (`MissingData`), a larger
    // one is a FAIL.
    let fund_after = e.after(&k(3), "the wedge fund")?;
    let spent = le(&fund_after.data, PF::SPENT_TOTAL, 8)
        .checked_sub(le(&fund_before.data, PF::SPENT_TOTAL, 8))
        .ok_or_else(|| {
            fail(
                WIDE_REPLAY_MISMATCH,
                "the wedge fund's spent_total went down",
            )
        })?;
    match fund_before.lamports.checked_sub(fund_after.lamports) {
        Some(drop) if drop == spent => {}
        Some(drop) if drop > spent => {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!("the wedge fund lost {drop} lamports but recorded {spent} spent"),
            ))
        }
        _ => {
            return Err(Missing(format!(
                "the wedge fund's lamports before: its balance moved by less than the {spent} lamports it recorded spent, so lamports reached it outside program transactions and its balance before is not in the archive"
            )))
        }
    }
    // The province holds what it held before (absent: 0, or a pre-funding
    // the archive shows) plus what the fund paid; less is a FAIL, more a
    // system transfer the archive may not show (`MissingData`).
    let prov_after = e.after(&target, "the province")?;
    let prov_before = e.acct_before(&target).map(|a| a.lamports).unwrap_or(0);
    match prov_after.lamports.cmp(&(prov_before + spent)) {
        std::cmp::Ordering::Equal => {}
        std::cmp::Ordering::Less => {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!(
                    "the province holds {} lamports, less than its {prov_before} before plus the {spent} the fund paid",
                    prov_after.lamports
                ),
            ))
        }
        std::cmp::Ordering::Greater => {
            return Err(Missing(format!(
                "the province holds {} lamports, more than its {prov_before} before plus the {spent} the fund paid: a pre-funding the archive may not show",
                prov_after.lamports
            )))
        }
    }
    opening.province.funded_lamports = spent;
    // The province, as the handler writes it into the zeroed account.
    let mut pd = vec![0u8; wl::province::SIZE];
    super::v11_land::encode_terrain(&terrain, &mut pd);
    wr_u32(&mut pd, PV::RESOLVED_NEXT, now_bell);
    wr_u32(&mut pd, PV2::SCORE_NEXT_BELL, now_bell);
    for i in 0..PV::SITES_N {
        let o = PV::site(i);
        pd[o + SM::STATE] = SM::STATE_FREE;
        pd[o + SM::FACTION] = NEUTRAL;
        wr_u32(&mut pd, o + SM::PEND0_BELL, SM::NO_BELL);
        wr_u32(&mut pd, o + SM::PEND1_BELL, SM::NO_BELL);
    }
    if let Some(fc) = opening.free_city_site {
        let o = PV::site(fc as usize);
        pd[o + SM2::STATE] = SM2::STATE_FREE_CITY;
        pd[o + SM2::FACTION] = NEUTRAL;
        pd[o + SM2::ORDER] = 0;
        pd[o + SM2::TIER] = Tier::Hamlet as u8;
        pd[o + SM2::GEN] = 0;
        pd[o + SM2::HELD_SINCE_HOUR..o + SM2::HELD_SINCE_HOUR + 2]
            .copy_from_slice(&0u16.to_le_bytes());
        wr_u32(&mut pd, o + SM2::GARRISON, garrison_milli);
    }
    if let Some(cmp) = opening.camp {
        pd[PV::CAMP + CP::TILE] = cmp.tile;
        pd[PV::CAMP + CP::STATE] = CP::STATE_PRESENT;
        wr_u32(&mut pd, PV::CAMP + CP::TROOPS, cmp.troops);
        wr_u32(&mut pd, PV::CAMP + CP::GEN, 1);
    }
    wr_u32(&mut pd, PV::CAMP + CP::NEXT_CHECK_DAY, day + 1);
    match keep.as_ref() {
        Some(kp) => frontier_abi::conquest_model::write_keep(&mut pd, kp),
        None => frontier_abi::conquest_model::write_no_keep(&mut pd),
    }
    .map_err(|er| fail(WIDE_ACCOUNTS, format!("the keep record: {er:?}")))?;
    opening
        .province
        .write_identity(&mut pd)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the identity: {er:?}")))?;
    // (devnet-territory-dev, as the handler since #209 T-1..T-8: the configuration's territory rule in the trailer)
    if !wl::set_territory_rule(&mut pd, cfg.keep_holder.territory()) {
        return Err(fail(WIDE_ACCOUNTS, "the territory rule byte"));
    }
    expect_after(e, &target, &pd, "the province")?;
    // The fund's counters.
    let mut fw = fund_before.data.clone();
    let add32 = |d: &[u8], o: usize, n: u64| {
        (le(d, o, 4))
            .checked_add(n)
            .filter(|v| *v <= u32::MAX as u64)
    };
    let (Some(open_sites), Some(opened), Some(funded), Some(total)) = (
        add32(&fw, PF::OPEN_SITES, terrain.site_count as u64),
        add32(&fw, PF::PROVINCES_OPENED, 1),
        add32(&fw, PF::PROVINCES_FUNDED, 1),
        le(&fw, PF::SPENT_TOTAL, 8).checked_add(spent),
    ) else {
        return Err(fail(
            WIDE_RULE,
            "a fund counter overflows (the program refuses)",
        ));
    };
    wr_u32(&mut fw, PF::OPEN_SITES, open_sites as u32);
    wr_u32(&mut fw, PF::PROVINCES_OPENED, opened as u32);
    wr_u32(&mut fw, PF::PROVINCES_FUNDED, funded as u32);
    wr_u64(&mut fw, PF::SPENT_TOTAL, total);
    expect_after(e, &k(3), &fw, "the wedge fund")?;
    let mut rw = vec![0u8; wl::ring_seed::SIZE];
    counted
        .write(&mut rw)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ring seed's bytes: {er:?}")))?;
    expect_after(e, &k(2), &rw, "the ring seed")?;
    Ok(vec![
        (target, Lam::Checked),
        (k(2), Lam::Same),
        (k(3), Lam::Checked),
    ])
}

/// One instruction: the command's re-run, then every other program account
/// of the transaction unchanged.
fn judge(e: &Env, ix: &Ix, sigs: &mut SigCache) -> Result<(), Wrong> {
    let cmd = WideCommand::decode(&ix.data).map_err(|er| {
        fail(
            UNDECODABLE,
            format!("the wide codec refuses the data ({er:?})"),
        )
    })?;
    let wrote = match &cmd {
        WideCommand::SetRules(x) => set_rules(e, ix, x)?,
        WideCommand::RequestRingSeed(x) => request_ring_seed(e, ix, x)?,
        WideCommand::ConsumeRingSeed(x) => consume_ring_seed(e, ix, x, sigs)?,
        WideCommand::OpenProvince(x) => open_province(e, ix, x)?,
        WideCommand::ClaimSite(x) => claims::claim_site(e, ix, x)?,
        WideCommand::SettleTicket(x) => claims::settle_ticket(e, ix, x)?,
        WideCommand::Finalize(_) => claims::finalize(e, ix)?,
        WideCommand::Close(x) => close::close(e, ix, x)?,
        WideCommand::Economy(x) => economy::economy(e, ix, x)?,
        WideCommand::Garrison(x) => economy::garrison(e, ix, x)?,
        WideCommand::Muster(x) => march::muster(e, ix, x)?,
        WideCommand::Resolve(x) => march::resolve(e, ix, x)?,
        _ => return Ok(()),
    };
    // The FULL post-state of every account of the transaction that the
    // program owns before or after it (round 2 of #72): listed by the instruction; never executable; the
    // handler's own accounts as the re-run wrote them (data and owner in
    // the handler, lamports by the rule it declared); every other one
    // unchanged in data, owner and lamports.
    let prog = |a: &Option<Account>| {
        a.as_ref()
            .is_some_and(|a| a.owner.to_bytes() == e.ctx.program)
    };
    for (k, a) in &e.w.txs[e.tx].post {
        let before = e.acct_before(k);
        // Round 3 of #72 (verify-pr72 B-2): a real archive's post-states
        // hold every writable account, the fee payer's wallet included.
        // An account the program owns neither before nor after is the
        // runtime's (fees, rent, system transfers), not this check's.
        if !prog(&before) && !prog(a) {
            continue;
        }
        if !ix.accounts.iter().any(|(x, _)| x == k) {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!(
                    "account {} changed, but the instruction does not list it",
                    b58(k)
                ),
            ));
        }
        if a.as_ref().is_some_and(|a| a.executable) || before.as_ref().is_some_and(|b| b.executable)
        {
            return Err(fail(
                WIDE_REPLAY_MISMATCH,
                format!("account {} is executable", b58(k)),
            ));
        }
        let rule = wrote.iter().find(|(x, _)| x == k).map(|(_, l)| *l);
        if rule.is_none() {
            let same = match (&before, a) {
                (Some(b), Some(a)) => b.data == a.data && b.owner == a.owner,
                (None, None) => true,
                _ => false,
            };
            if !same {
                if before.is_none() && !e.known_before(k) && a.is_some() && e.snapshot.is_some() {
                    return Err(Missing(format!(
                        "account {}: the witness has no state before",
                        b58(k)
                    )));
                }
                return Err(fail(
                    WIDE_REPLAY_MISMATCH,
                    format!(
                        "account {} changed, which this handler never writes",
                        b58(k)
                    ),
                ));
            }
        }
        if matches!(rule, None | Some(Lam::Same)) {
            if let (Some(b), Some(a)) = (&before, a) {
                lamports_unchanged(b.lamports, a.lamports, k)?;
            } else if a.is_some() && rule.is_some() {
                return Err(Missing(format!(
                    "account {}: the archive has no balance before",
                    b58(k)
                )));
            }
        }
    }
    Ok(())
}

/// How a handler's written account's lamports are judged in [`judge`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lam {
    /// The handler compared them itself (a created or funded record, a
    /// fund that paid).
    Checked,
    /// The handler never moves its lamports: unchanged.
    Same,
    /// Created by the instruction from the payer's wallet: the runtime
    /// makes it rent-exempt, and more is a pre-funding nobody can rule
    /// out; nothing to compare.
    Created,
    /// Closed by the instruction: the handler checked that nothing of it
    /// remains (`close::expect_closed`).
    Closed,
}

/// An account whose balance the handler never moves. Only the owning
/// program can debit it, so a lower balance after is a FAIL; a higher one
/// may be a system transfer the archive (program transactions only)
/// never shows: `MissingData`.
fn lamports_unchanged(before: u64, after: u64, k: &Key) -> Result<(), Wrong> {
    match after.cmp(&before) {
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Less => Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "account {} lost {} lamports, which this handler never moves",
                b58(k),
                before - after
            ),
        )),
        std::cmp::Ordering::Greater => Err(Missing(format!(
            "account {} gained {} lamports this handler never moves: a system transfer may have reached it outside the archive",
            b58(k),
            after - before
        ))),
    }
}

/// Every successful wide land instruction of `w`, judged; findings in order.
#[allow(clippy::too_many_arguments)]
fn judge_all(
    w: &World,
    recs: &[fclient::ports::TxRecord],
    snapshot: Option<&BTreeMap<Key, Option<Account>>>,
    declared: &[crate::input::Declared],
    program: &Key,
    season_id: u64,
    quicknet_pk: [u8; 96],
    sigs: &mut SigCache,
) -> Vec<(usize, String, Wrong)> {
    let ctx = findex::addr_ctx(
        &solana_address::Address::new_from_array(*program),
        season_id,
    );
    let mut out = vec![];
    for (i, t) in w.txs.iter().enumerate() {
        if !t.ok {
            continue;
        }
        let env = || Env {
            w,
            recs,
            snapshot,
            declared,
            read_declared: std::cell::Cell::new(false),
            ctx,
            sid: season_id,
            tx: i,
            now: t.time,
            quicknet_pk,
        };
        // Player territory (#209, verifier-territory): a transaction of
        // territory instructions is judged as a whole (the keeper's settle
        // + decay and settle + conquer share one, `vwl_wide_territory`).
        let terr: Vec<&'static str> = t.ixs.iter().filter_map(territory::of).collect();
        if !terr.is_empty() {
            let name = terr.join("+");
            if terr.len() != t.ixs.len() {
                out.push((
                    i,
                    name,
                    Missing("territory instructions beside another program instruction: the archive has no state between them".into()),
                ));
                continue;
            }
            let e = env();
            match territory::judge_tx(&e, &t.ixs) {
                Err(er) => out.push((i, name, er)),
                Ok(()) if e.read_declared.get() => out.push((
                    i,
                    name,
                    Missing("re-judged exactly, but from a state the archive only declares (a recorder's patch, not an archived transaction's write)".into()),
                )),
                Ok(()) => {}
            }
            continue;
        }
        for ix in &t.ixs {
            let Some(name) = ix
                .tag()
                .filter(|t| super::v0_coverage::is_wide_tag(*t))
                .and_then(|_| judged(&ix.data))
            else {
                continue;
            };
            let name = name.to_string();
            if t.ixs.len() != 1 {
                out.push((
                    i,
                    name,
                    Missing("it shares its transaction with another program instruction: the archive has no state between them".into()),
                ));
                continue;
            }
            let e = env();
            match judge(&e, ix, sigs) {
                Err(er) => out.push((i, name, er)),
                Ok(()) if e.read_declared.get() => out.push((
                    i,
                    name,
                    Missing("re-judged exactly, but from a state the archive only declares (a recorder's patch, not an archived transaction's write)".into()),
                )),
                Ok(()) => {}
            }
        }
    }
    out
}

pub fn run(cx: &mut Ctx) {
    let pv = cx.f.params.as_ref().map(|p| p.program_version);
    if !super::v0_coverage::playable(pv) {
        return;
    }
    let mut sigs = SigCache::default();
    let found = judge_all(
        cx.w,
        &cx.input.txs,
        None,
        &cx.input.declared,
        &cx.cfg.program.to_bytes(),
        cx.cfg.season_id,
        cx.cfg.quicknet_pk,
        &mut sigs,
    );
    for (i, name, er) in found {
        match er {
            Fail(code, d) => cx.fail(
                V,
                code,
                format!("tx#{i}"),
                0,
                Some(i),
                format!("{name}: {d}"),
            ),
            Missing(d) => cx.missing(V, format!("tx#{i}"), 0, Some(i), format!("{name}: {d}")),
        }
    }
}

/// An archive **segment** judged from an execution witness: `snapshot`
/// holds the state (absent = `None`) of every account the segment's
/// instructions name, as it stood before the segment's first transaction.
/// Only VWL's judgement of its wide land instructions; no season verdict
/// (the states before the segment are the witness's claim, not history).
pub fn judge_segment(input: &Input, snapshot: &BTreeMap<Key, Option<Account>>) -> Vec<Finding> {
    // The check of the check: a `mutate-vwl` build judges nothing.
    if cfg!(feature = "mutate-vwl") {
        return vec![];
    }
    let w = World::parse(
        &input.cfg.program,
        &input.txs,
        input.finals.clone(),
        input.final_slot,
    );
    let mut sigs = SigCache::default();
    judge_all(
        &w,
        &input.txs,
        Some(snapshot),
        &input.declared,
        &input.cfg.program.to_bytes(),
        input.cfg.season_id,
        input.cfg.quicknet_pk,
        &mut sigs,
    )
    .into_iter()
    .map(|(i, name, er)| {
        let (severity, code, d) = match er {
            Fail(c, d) => (Severity::Fail, c.to_string(), d),
            Missing(d) => (Severity::Unverifiable, MISSING_DATA.to_string(), d),
        };
        Finding {
            code,
            severity,
            check: V,
            entity: format!("tx#{i}"),
            bell: 0,
            signature: w.txs.get(i).map(|t| t.sig.clone()).unwrap_or_default(),
            detail: format!("{name}: {d}"),
        }
    })
    .collect()
}
