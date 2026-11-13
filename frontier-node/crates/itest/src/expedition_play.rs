//! **Temporary local-play runner** (feature `localnet-expedition-play`, bin
//! `localnet-expedition-play`): the isolated `localnet-expedition-sbf`
//! artifact really executed in the in-process LiteSVM chain
//! (`localnet::Chain`), served on loopback by the existing
//! `localnet::server::start_with`, with a synthetic first world owned by a
//! player's PUBLIC wallet key.
//!
//! What it checks before binding anything: the artifact is an absolute path,
//! an SBPF v2 ELF of the expected SHA-256 carrying the fixed marker
//! `PSF_LOCALNET_EXPEDITION_SBF_BUILD`; the program id is the dedicated
//! `[0x45; 32]` and the dispatch revision `0x4804`; the node's feature set
//! has the BLS12-381 syscalls and SBPF v2; both ports are explicit, distinct,
//! free loopback ports in 41000–41999 (the node's own rule), never 41970.
//!
//! What it is NOT, and says so in its metadata:
//! - the initial Season, Frontier, RingSeed of the home ring, Citizen,
//!   Holding and home Province are a FIXTURE written with
//!   `Chain::set_account`; no CreateSeason, GenesisSeed, OpenRing,
//!   OpenProvince, Join, PlaceHome, ticket or Muster instruction ran. The Season's
//!   parameters are the real `S1_LOCAL_7D` preset (Quicknet network, public
//!   key hash, drand genesis/period, reveal window, seed margin, conquest
//!   block) written as CreateSeason's `write_params` writes them, with these
//!   stated overrides: status Running, program version 0x4804, `r_max` 128
//!   (the home ring) with no extension ceiling, and a genesis aligned to a
//!   real Quicknet round so the chain's present is bell 10. The genesis seed
//!   stays zero (as CreateSeason leaves it). The Frontier says rings
//!   0..=128 are opened (so the home ring is in the map) and one Province
//!   exists; rings 0..=127 have no RingSeed or Province and show as such.
//!   The home ring's RingSeed is SEEDED with a ZERO seed and round 0: not a
//!   beacon value;
//! - no keeper, herald, gateway, relay or beacon process is started, and no
//!   lifecycle step after Depart is driven;
//! - the chain is memory only (`data_dir: None`), `allow_tamper: false`,
//!   served under `localnet::server::Policy::MEMORY_ONLY` (snapshot to a
//!   path, restore from one and setAccount refused before any parameter is
//!   read), and listens on 127.0.0.1 only. The node's time and inclusion
//!   controls (`frontier_pause/resume/setScale/hold/release`) stay as the
//!   node serves them. No key is generated, read, stored or
//!   printed: the player signs elsewhere with its own wallet. The disposable
//!   chain's faucet funds the player's public key so it can pay fees.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use fclient::ports::Account;
use fclient::Address;
use frontier_abi::addr::{host_id, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_i16, wr_u16, wr_u32, wr_u64};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::{
    header,
    player::{citizen as C1, holding_ref as HR},
    province::{entry as E, site as SM1},
};
use frontier_abi::v2::layout::{
    player::{citizen as C, holding as H},
    province::{province as P, site as SM},
    world::season as S,
};
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::layout::world::join_shard as JS;
use frontier_abi::v2::presets::{RULES_VERSION_S1, RULESET_HASH_V3, S1_LOCAL_7D, SEASON_CQ_OFFSET};
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use permutation_rules::frontier::beacon::{genesis_ts as beacon_genesis_ts, BeaconClock};
use permutation_rules::frontier::geometry::ProvinceCoord;
use frontier_abi::world_index::{expedition::AccountResolver, expedition_dispatch_ix as wire, WideHostRef};
use localnet::{server, Chain, Config};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const SCHEMA: &str = "frontier-localnet-expedition-play-v1";
/// The player's faction: the Citizen's, the Holding's, the home's site mirror
/// and roster entry all carry it.
pub const FACTION: u8 = 0;
/// The dedicated program id of the `localnet-expedition-sbf` build.
pub const PROGRAM: [u8; 32] = [0x45; 32];
/// S1 (4) | wide 0x4000 | host-only dispatch 0x0800.
pub const PROGRAM_VERSION: u16 = 0x4804;
pub const MARKER: &[u8] = b"PSF_LOCALNET_EXPEDITION_SBF_BUILD";
/// The usual stack's port: this runner never takes it.
pub const REFUSED_PORT: u16 = 41970;
pub const SEASON_ID: u64 = 11;
pub const BELL_SECS: u32 = 600;
/// The chain's clock stands this far after the Season's genesis (bell 10).
pub const INTO_SEASON: i64 = 6_000;
/// Fees for the player's own transactions, from the disposable faucet.
pub const PLAYER_LAMPORTS: u64 = 10_000_000_000;
const FIXTURE_LAMPORTS: u64 = 10_000_000_000;
const _: () = assert!(wire::PROGRAM_VERSION == PROGRAM_VERSION);

/// The runner's arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub artifact: PathBuf,
    pub sha256: String,
    pub player_wallet: Address,
    pub rpc_port: u16,
    pub ws_port: u16,
    /// `--keeper public-quicknet`: the opt-in keeper loop (`keeper_loop`).
    pub keeper: bool,
    /// `--wide-destination public-quicknet`: the opt-in isolated test
    /// fixture that makes the wide Province (129, 0) real
    /// (`wide_destination`; SYNTHETIC requested ring seed and Season
    /// authority, REAL Consume / SetRules / WideOpenProvince).
    pub wide_destination: bool,
}

/// The only keeper value: public drand Quicknet rounds, verified.
pub const KEEPER_PUBLIC_QUICKNET: &str = "public-quicknet";

const FLAGS: [&str; 5] = ["--artifact", "--artifact-sha256", "--player-wallet", "--rpc-port", "--ws-port"];

/// Exactly the five `--flag value` pairs, each once, any order, and
/// optionally `--keeper public-quicknet` once.
pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Options, String> {
    let mut args: Vec<String> = args.into_iter().collect();
    let mut keeper = false;
    if let Some(i) = args.iter().position(|a| a == "--keeper") {
        if i % 2 != 0 || args.get(i + 1).map(String::as_str) != Some(KEEPER_PUBLIC_QUICKNET) {
            return Err(format!("--keeper takes exactly `{KEEPER_PUBLIC_QUICKNET}`"));
        }
        args.drain(i..i + 2);
        keeper = true;
        if args.iter().any(|a| a == "--keeper") {
            return Err("--keeper given twice".into());
        }
    }
    let mut wide_destination = false;
    if let Some(i) = args.iter().position(|a| a == "--wide-destination") {
        if i % 2 != 0 || args.get(i + 1).map(String::as_str) != Some(crate::wide_destination::MODE) {
            return Err(format!("--wide-destination takes exactly `{}`", crate::wide_destination::MODE));
        }
        args.drain(i..i + 2);
        wide_destination = true;
        if args.iter().any(|a| a == "--wide-destination") {
            return Err("--wide-destination given twice".into());
        }
    }
    if args.len() != FLAGS.len() * 2 {
        return Err(format!("usage: {}", FLAGS.map(|f| format!("{f} <value>")).join(" ")));
    }
    let mut values: [Option<&str>; 5] = [None; 5];
    for pair in args.chunks(2) {
        let i = FLAGS.iter().position(|f| *f == pair[0]).ok_or_else(|| format!("unknown argument {}", pair[0]))?;
        if values[i].replace(&pair[1]).is_some() {
            return Err(format!("{} given twice", pair[0]));
        }
    }
    let v = |i: usize| values[i].expect("every flag counted");
    let artifact = PathBuf::from(v(0));
    if !artifact.is_absolute() {
        return Err("--artifact must be an absolute path".into());
    }
    let sha256 = v(1).to_owned();
    if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("--artifact-sha256 must be 64 lowercase hex characters".into());
    }
    let player_wallet: Address = v(2).parse().map_err(|_| "--player-wallet is not a public key".to_string())?;
    if player_wallet.to_string() != v(2) {
        return Err("--player-wallet is not a canonical public key".into());
    }
    check_wallet(&player_wallet)?;
    let port = |i: usize, name: &str| -> Result<u16, String> {
        let p: u16 = v(i).parse().map_err(|_| format!("{name} is not a port"))?;
        if p.to_string() != v(i) {
            return Err(format!("{name} is not a canonical port"));
        }
        Ok(p)
    };
    let (rpc_port, ws_port) = (port(3, "--rpc-port")?, port(4, "--ws-port")?);
    check_ports(rpc_port, ws_port)?;
    Ok(Options { artifact, sha256, player_wallet, rpc_port, ws_port, keeper, wide_destination })
}

/// Explicit, distinct, free loopback ports in 41000–41999, never 41970 or a
/// port the node itself reserves (`localnet::server::check_port`, which also
/// refuses a port some listener already holds).
pub fn check_ports(rpc: u16, ws: u16) -> Result<(), String> {
    for p in [rpc, ws] {
        if p == 0 {
            return Err("ports must be explicit (not 0)".into());
        }
        if p == REFUSED_PORT {
            return Err(format!("port {REFUSED_PORT} belongs to the usual stack; refused"));
        }
        server::check_port(p)?;
    }
    if rpc == ws {
        return Err("--rpc-port and --ws-port must differ".into());
    }
    Ok(())
}

/// The player wallet is a usable public key: not the default (all zero),
/// not the dedicated program, not the program's Season.
pub fn check_wallet(w: &Address) -> Result<(), String> {
    let program = Address::new_from_array(PROGRAM);
    if *w == Address::default() || *w == program || *w == fclient::addr::season_pda(&program, SEASON_ID).0 {
        return Err("--player-wallet is not a usable public key".into());
    }
    Ok(())
}

/// A checked artifact (only [`inspect`] makes one).
pub struct Artifact {
    path: PathBuf,
    bytes: Vec<u8>,
    sha256: String,
}
impl Artifact {
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

/// The artifact's checks on bytes: an ELF with SBPF v2 `e_flags`, the
/// expected digest and the fixed marker. (The dedicated id is enforced by the
/// program at run time, not searched for as bytes.)
pub fn inspect(path: PathBuf, bytes: Vec<u8>, expected_sha: &str) -> Result<Artifact, String> {
    if bytes.len() < 64 || bytes[..4] != [0x7f, b'E', b'L', b'F'] {
        return Err("the artifact is not an ELF file".into());
    }
    if u32::from_le_bytes(bytes[48..52].try_into().expect("4")) != 2 {
        return Err("the artifact is not SBPF v2 (e_flags != 2)".into());
    }
    let sha256 = hex::encode(Sha256::digest(&bytes));
    if sha256 != expected_sha {
        return Err(format!("the artifact's SHA-256 is {sha256}, not the expected {expected_sha}"));
    }
    if !bytes.windows(MARKER.len()).any(|w| w == MARKER) {
        return Err("the marker PSF_LOCALNET_EXPEDITION_SBF_BUILD is not in the artifact".into());
    }
    Ok(Artifact { path, bytes, sha256 })
}

pub fn read_artifact(o: &Options) -> Result<Artifact, String> {
    let bytes = std::fs::read(&o.artifact).map_err(|e| format!("cannot read the artifact: {e}"))?;
    inspect(o.artifact.clone(), bytes, &o.sha256)
}

fn header_bytes(size: usize, magic: [u8; 8]) -> Vec<u8> {
    let mut d = vec![0; size];
    assert!(wr_arr(&mut d, header::MAGIC, &magic));
    assert!(wr_u64(&mut d, header::SEASON_ID, SEASON_ID));
    assert!(wr_u16(&mut d, header::LAYOUT_VERSION, 2));
    d
}

/// The synthetic first world: the original host (128, 0) site 1 gen 2 seq 0
/// of `wallet`, final and resident at home, in a running Season of the
/// dispatch revision (real S1 ruleset hash) whose bell 10 is `now`.
pub struct Fixture {
    pub season: Address,
    pub host: WideHostRef,
    pub citizen: Address,
    pub holding: Address,
    pub home: Address,
    pub frontier: Address,
    pub ring_seed: Address,
    pub home_ring: u16,
    pub genesis_ts: i64,
    pub genesis_round: u64,
    /// The Holding's `RENT_PAYER` (SYNTHETIC): PlaceHome stores its fee
    /// payer there; here a fresh in-memory test key (its secret dropped at
    /// once, never stored or printed) that `install` funds from the node's
    /// faucet, so the address is a live, non-executable system wallet.
    pub rent_payer: Address,
    accounts: Vec<(Address, Vec<u8>)>,
}

/// The test funding wallet's faucet airdrop (a live system account).
const RENT_PAYER_LAMPORTS: u64 = 1_000_000_000;

/// The Season as CreateSeason's `write_params` writes the real
/// `S1_LOCAL_7D` preset (proc/season.rs), with the stated overrides: status
/// Running, bump, version 0x4804, S1 ruleset/rules version, `r_max` 128 and
/// no ceiling, and the genesis round whose `genesis_ts` (round time + 600)
/// is the latest one at or before `now - INTO_SEASON`.
fn season_bytes(bump: u8, now: i64) -> Result<(Vec<u8>, i64, u64), String> {
    let p = S1_LOCAL_7D.base;
    let mut cq = S1_LOCAL_7D.cq;
    cq.r_max_ceiling = 0;
    let clock = BeaconClock { genesis: p.drand_genesis, period: p.drand_period as i64 };
    let target = now - INTO_SEASON;
    // round_time(r) = genesis + (r - 1) * period; genesis_ts = round_time + 600
    let r = ((target - 600 - p.drand_genesis) / p.drand_period as i64 + 1).max(1) as u64;
    let genesis_ts = beacon_genesis_ts(&clock, r);
    if genesis_ts > target || target - genesis_ts >= p.drand_period as i64 {
        return Err("genesis alignment".into());
    }
    let mut s = vec![0u8; S::SIZE];
    if !write_header(&mut s, K2::Season, SEASON_ID) {
        return Err("season header".into());
    }
    let w32 = |s: &mut Vec<u8>, o: usize, v: u32| assert!(wr_u32(s, o, v));
    s[S::STATUS] = S::STATUS_RUNNING;
    s[S::BUMP] = bump;
    s[S::REGIONS] = p.regions;
    s[S::GENESIS_RING] = p.genesis_ring;
    assert!(wr_u16(&mut s, S::R_MAX, 128));
    s[S::OFFICE_TERMS_PER_WALLET] = p.office_terms_per_wallet;
    s[S::POSTURES_ENABLED] = p.postures_enabled;
    assert!(wr_arr(&mut s, S::RULESET_HASH, &RULESET_HASH_V3));
    assert!(wr_u16(&mut s, S::RULES_VERSION, RULES_VERSION_S1));
    assert!(wr_u16(&mut s, S::PROGRAM_VERSION, PROGRAM_VERSION));
    w32(&mut s, S::BELL_SECS, p.bell_secs);
    assert!(wr_arr(&mut s, S::GENESIS_TS, &genesis_ts.to_le_bytes()));
    assert!(wr_arr(&mut s, S::CREATED_TS, &genesis_ts.to_le_bytes()));
    w32(&mut s, S::JOIN_CLOSE_BELL, p.join_close_bell);
    w32(&mut s, S::END_BELL, p.end_bell);
    assert!(wr_arr(&mut s, S::DRAND_GENESIS, &p.drand_genesis.to_le_bytes()));
    w32(&mut s, S::DRAND_PERIOD, p.drand_period);
    s[S::NETWORK] = p.network;
    assert!(wr_arr(&mut s, S::QUICKNET_PK_HASH, &p.quicknet_pk_hash));
    w32(&mut s, S::REVEAL_WINDOW, p.reveal_window);
    w32(&mut s, S::SEED_MARGIN, p.seed_margin);
    w32(&mut s, S::WINDOW_NEXT, p.reveal_window);
    w32(&mut s, S::WINDOW_FROM_BELL, S::WINDOW_NONE);
    assert!(wr_u64(&mut s, S::GENESIS_ROUND, r));
    w32(&mut s, S::ARCHIVE_AFTER, p.archive_after);
    s[S::MIN_LEAD] = p.min_lead;
    s[S::MAX_LEAD] = p.max_lead;
    s[S::TRANSIT_SLOTS] = p.transit_slots;
    assert!(wr_u64(&mut s, S::MARCH_FEE, p.march_fee));
    assert!(wr_u64(&mut s, S::SEAL_BOND, p.seal_bond));
    w32(&mut s, S::MIN_REVEAL_PRIORITY_MILLI, p.min_reveal_priority_milli);
    w32(&mut s, S::REVEAL_CU_LIMIT, p.reveal_cu_limit);
    assert!(wr_u16(&mut s, S::BUCKET_RATE_PER_H, p.bucket_rate_per_h));
    assert!(wr_u16(&mut s, S::BUCKET_BURST, p.bucket_burst));
    w32(&mut s, S::DEFENCE_CAP_MILLI, p.defence_cap_milli);
    s[S::LATENESS_SLOTS] = p.lateness_slots;
    assert!(wr_u16(&mut s, S::THETA_EARLY_BPS, p.theta_early_bps));
    assert!(wr_u16(&mut s, S::THETA_LATE_BPS, p.theta_late_bps));
    w32(&mut s, S::THETA_SWITCH_SECS, p.theta_switch_secs);
    assert!(wr_u16(&mut s, S::RESERVE_BPS, p.reserve_bps));
    assert!(wr_u16(&mut s, S::EXTRA_FREE_BPS, p.extra_free_bps));
    w32(&mut s, S::CLASH_CLOSE_GRACE, p.clash_close_grace);
    w32(&mut s, S::CAMP_REGROW_BELLS, p.camp_regrow_bells);
    w32(&mut s, S::DORMANT_AFTER_SECS, p.dormant_after_secs);
    w32(&mut s, S::RELEASE_AFTER_SECS, p.release_after_secs);
    assert!(wr_u64(&mut s, S::PFUND_INITIAL, p.pfund_initial));
    assert!(wr_u64(&mut s, S::DPOOL_INITIAL, p.dpool_initial));
    w32(&mut s, S::REVEAL_LOADED_LIMIT, p.reveal_loaded_limit);
    assert!(wr_arr(&mut s, S::JOIN_GATE, &p.join_gate));
    s[SEASON_CQ_OFFSET..SEASON_CQ_OFFSET + cq.to_bytes().len()].copy_from_slice(&cq.to_bytes());
    Ok((s, genesis_ts, r))
}

/// The accounts that exist before the home Province is opened (synthetic):
/// the Season, the Frontier, the home ring's RingSeed (zero seed, round 0)
/// and the home wedge's ProvinceFund, which pays the Province's rent.
pub struct Base {
    pub season: Address,
    pub frontier: Address,
    pub ring_seed: Address,
    pub fund: Address,
    pub home_ring: u16,
    pub genesis_ts: i64,
    pub genesis_round: u64,
    accounts: Vec<(Address, Vec<u8>, u64)>,
}

/// Lamports of the home wedge's fund: OpenProvince takes the Province's rent from it.
const FUND_LAMPORTS: u64 = 100_000_000_000;

impl Base {
    pub fn new(now: i64) -> Result<Base, String> {
        let program = Address::new_from_array(PROGRAM);
        let (season, bump) = fclient::addr::season_pda(&program, SEASON_ID);
        let ctx = AddrCtx { program: PROGRAM, season: season.to_bytes() };
        let (s, genesis_ts, genesis_round) = season_bytes(bump, now)?;
        let coord = ProvinceCoord::new(128, 0);
        let ring = coord.ring() as u16;
        let mut fr = vec![0u8; K2::Frontier.size()];
        if !write_header(&mut fr, K2::Frontier, SEASON_ID) {
            return Err("frontier header".into());
        }
        assert!(wr_u16(&mut fr, FR::RINGS_OPENED, ring + 1));
        assert!(wr_u32(&mut fr, FR::PROVINCES_OPENED, 1));
        let mut rs = vec![0u8; K2::RingSeed.size()];
        if !write_header(&mut rs, K2::RingSeed, SEASON_ID) {
            return Err("ring seed header".into());
        }
        assert!(wr_u16(&mut rs, RS::D, ring));
        rs[RS::STATUS] = RS::STATUS_SEEDED;
        // SEED and ROUND stay zero: not a beacon value (see the module doc).
        let wedge = fclient::ix::wedge_of(128, 0);
        let mut fund = vec![0u8; K2::ProvinceFund.size()];
        if !write_header(&mut fund, K2::ProvinceFund, SEASON_ID) {
            return Err("fund header".into());
        }
        fund[frontier_abi::layout::world::province_fund::WEDGE] = wedge;
        let frontier = Address::new_from_array(ctx.frontier());
        let ring_seed = Address::new_from_array(ctx.ring_seed(ring));
        let fund_key = Address::new_from_array(ctx.province_fund(wedge));
        Ok(Base {
            season, frontier, ring_seed, fund: fund_key, home_ring: ring, genesis_ts, genesis_round,
            accounts: vec![(season, s, FIXTURE_LAMPORTS), (frontier, fr, FIXTURE_LAMPORTS), (ring_seed, rs, FIXTURE_LAMPORTS), (fund_key, fund, FUND_LAMPORTS)],
        })
    }

    /// Writes the base accounts, owned by the dedicated program.
    pub fn install(&self, c: &mut Chain) -> Result<(), String> {
        for (key, data, lamports) in &self.accounts {
            c.set_account(*key, Account { lamports: *lamports, data: data.clone(), owner: Address::new_from_array(PROGRAM), executable: false })?;
        }
        Ok(())
    }

    /// SYNTHETIC (the wide-destination fixture only): the Season stores
    /// `authority` (an in-memory test key's public key) as its authority.
    pub fn set_authority(&mut self, authority: &Address) {
        let season = self.season;
        let s = &mut self.accounts.iter_mut().find(|(k, _, _)| *k == season).expect("the Season").1;
        assert!(wr_arr(s, S::AUTHORITY, &authority.to_bytes()));
    }

    fn data(&self, key: &Address) -> &[u8] {
        &self.accounts.iter().find(|(k, _, _)| k == key).expect("a base account").1
    }
}

/// Opens the home Province (128, 0) with the REAL OpenProvince instruction of
/// the deployed program, paid by a fresh in-memory fee payer funded by the
/// disposable faucet (never stored or printed). The program writes the
/// terrain from the RingSeed's seed, the keep, the initial camp, the Free
/// City where due, `resolved_next = opened_bell = now_bell`. Returns the
/// Province bytes it wrote and the transaction's signature.
pub fn open_home(c: &mut Chain) -> Result<(Vec<u8>, String), String> {
    let payer = fclient::Keypair::new();
    c.airdrop(&fclient::Signer::pubkey(&payer), 10_000_000_000)?;
    c.produce_block();
    let program = Address::new_from_array(PROGRAM);
    let ix = fclient::ix::open_province(&fclient::addr::Addresses::new(program, SEASON_ID), fclient::Signer::pubkey(&payer), 128, 0);
    let budget = fclient::tx::TxBudget { cu_limit: 1_400_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(256 * 1024) };
    let (blockhash, _) = c.latest_blockhash();
    let t = fclient::tx::build(&[ix], &budget, &[&payer], &blockhash)?;
    let sig = c.submit(&fclient::tx::wire(&t)).map_err(|e| format!("OpenProvince refused before landing: {e}"))?;
    c.produce_block();
    let landed = c.transaction(&sig).cloned().ok_or("OpenProvince did not land")?;
    if let Some(err) = landed.err {
        let tail: Vec<_> = landed.logs.iter().rev().take(6).rev().cloned().collect();
        return Err(format!("OpenProvince failed: {err} (code {:?}) {tail:?}", landed.code));
    }
    let ctx = AddrCtx { program: PROGRAM, season: fclient::addr::season_pda(&program, SEASON_ID).0.to_bytes() };
    let home = c.account(&Address::new_from_array(ctx.province(128, 0))).ok_or("no Province after OpenProvince")?;
    Ok((home.data, sig.to_string()))
}

impl Fixture {
    /// The player's first holding and host on the Province OpenProvince
    /// opened (`opened`): the first FREE site of its real site list becomes
    /// the holding (gen 2) owned by the wallet's Citizen; the home's site
    /// mirror of that site says so and its roster holds the host (12,000 at
    /// the holding's tile). These owner records are SYNTHETIC (no Join, PlaceHome,
    /// ticket or Muster ran); the terrain, keep, camp and resolution fields
    /// stay exactly the program's.
    pub fn new(wallet: &Address, base: &Base, opened: &[u8]) -> Result<Fixture, String> {
        let program = Address::new_from_array(PROGRAM);
        let ctx = AddrCtx { program: PROGRAM, season: base.season.to_bytes() };
        let resolver = AccountResolver::for_season(&ctx).map_err(|e| format!("resolver: {e:?}"))?;
        let pv = fclient::decode::Province::decode(opened).map_err(|e| format!("opened Province: {e:?}"))?;
        if (pv.p, pv.q) != (128, 0) {
            return Err("opened Province is not (128, 0)".into());
        }
        let site = (0..pv.site_count as usize)
            .find(|&i| pv.site_mirror[i].state == SM1::STATE_FREE)
            .ok_or("the opened home has no free site")? as u8;
        let tile = pv.sites[site as usize];
        let gen = 2u8;
        let id = host_id(128, 0, site, gen, 0).ok_or("host id")?;
        let host = resolver.legacy_host_ref(id).map_err(|e| format!("host: {e:?}"))?;
        let citizen = Address::new_from_array(ctx.citizen(&wallet.to_bytes()));

        let mut h = header_bytes(H::SIZE, H::MAGIC);
        assert!(wr_i16(&mut h, H::P, 128));
        h[H::SITE] = site;
        h[H::GEN] = gen;
        h[H::TILE] = tile;
        h[H::STATE] = H::STATE_FINAL;
        h[H::ORDER] = 1;
        // as PlaceHome's Founding: the owner's faction, no ticket behind it
        h[H::FACTION] = FACTION;
        assert!(wr_u32(&mut h, H::TICKET_BELL, C::NO_TICKET));
        assert!(wr_arr(&mut h, H::OWNER_CITIZEN, &citizen.to_bytes()));
        assert!(wr_u32(&mut h, H::HOST_SEQ, 1));
        // PlaceHome writes its payer here (proc/citizen.rs `rent_payer: key(payer)`);
        // left zero it would be the executable System Program, which every
        // later refund to the rent payer (member settlement included) refuses
        let rent_payer = fclient::Signer::pubkey(&fclient::Keypair::new());
        assert!(wr_arr(&mut h, H::RENT_PAYER, &rent_payer.to_bytes()));

        let mut home = opened.to_vec();
        let m = P::site(site as usize);
        // The owner mirror agrees with the Holding, Citizen and host: held,
        // gen 2, order 1, faction 0 (OpenProvince left a FREE site NEUTRAL),
        // tier 0 as the Holding's. Garrison, pending deltas, walls, shield and
        // held-since stay zero: no Join/finalize ran to set them.
        home[m + SM::STATE] = SM1::STATE_HOLDING;
        home[m + SM::GEN] = gen;
        home[m + SM::ORDER] = 1;
        home[m + SM::FACTION] = FACTION;
        home[m + SM::TIER] = h[H::TIER];
        let n = home[P::N_ENTRIES] as usize;
        let entry = Entry {
            id,
            unit: 2,
            faction: FACTION,
            tile,
            state: E::STATE_ROSTER,
            troops: 12_000,
            stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
            op: EntryOp::None,
            ..Entry::FREE
        };
        write_entry(&mut home, n, &entry).map_err(|e| format!("roster entry: {e:?}"))?;
        home[P::N_ENTRIES] = (n + 1) as u8;

        // The Citizen in the resident poststate the REAL Join then PlaceHome
        // leave (proc/citizen.rs: Join writes FLAG_JOINED, the faction,
        // TICKET_BELL = NO_TICKET and clears every holding slot to gen 0xFF;
        // PlaceHome writes slot 1, HOME_GRANTED | FIRST_HOLDING_FINAL and
        // HOLDINGS_N = 1). Still SYNTHETIC: neither instruction ran; fields
        // only they compute (session, join bell/shard, rent payer, explores
        // floor, bucket time) stay zero. The citizen tag is the one identity
        // Join derives from the Citizen's own address
        // (`addr::citizen_tag(citizen.key)`, proc/citizen.rs); it is written
        // so the program's identity checks (for example the capture escrow's
        // `validate_inventory`) see the identifier a real Join leaves.
        let mut cd = header_bytes(C::SIZE, C::MAGIC);
        assert!(wr_arr(&mut cd, C::WALLET, &wallet.to_bytes()));
        assert!(wr_u64(&mut cd, C::CITIZEN_TAG, frontier_abi::addr::citizen_tag(&citizen.to_bytes())));
        // Join also records the wallet's join shard (`addr::join_shard_of`), and
        // InitShards + Join + PlaceHome (+ finality) leave that faction shard's
        // JoinShard counting this one member and its one final home Holding.
        // SYNTHETIC: none of those instructions ran; the shard below is that
        // poststate, so identity checks such as SettleCapture's JoinShard see it.
        let shard = frontier_abi::addr::join_shard_of(&wallet.to_bytes());
        cd[C::JOIN_SHARD] = shard;
        let join_shard = Address::new_from_array(ctx.join_shard(FACTION, shard));
        let mut js = header_bytes(JS::SIZE, JS::MAGIC);
        js[JS::FACTION] = FACTION;
        js[JS::SHARD] = shard;
        let wedge = permutation_rules::frontier::geometry::ProvinceCoord::new(128, 0).wedge().unwrap_or(0) as usize;
        for off in [JS::MEMBERS, JS::HOLDINGS, JS::FINAL_HOLDINGS, JS::HOLDINGS_BY_WEDGE + 4 * wedge] {
            assert!(wr_u32(&mut js, off, 1));
        }
        assert!(wr_u32(&mut cd, C1::BUCKET_MILLI, 5_000));
        cd[C::FACTION] = FACTION;
        cd[C::FLAGS] = C::FLAG_JOINED | C::FLAG_FIRST_HOLDING_FINAL | C::FLAG_HOME_GRANTED;
        cd[C::HOLDINGS_N] = 1;
        assert!(wr_u32(&mut cd, C::TICKET_BELL, C::NO_TICKET));
        for unused in 2..=3u8 {
            let o = C::holding_of_slot(unused);
            cd[o..o + HR::SIZE].fill(0);
            cd[o + HR::GEN] = C::EMPTY_GEN;
        }
        let slot = C::holding_of_slot(1);
        assert!(wr_i16(&mut cd, slot + HR::P, 128));
        cd[slot + HR::SITE] = site;
        cd[slot + HR::GEN] = gen;

        let holding = Address::new_from_array(resolver.holding_address(&host).map_err(|e| format!("holding: {e:?}"))?);
        let home_key = Address::new_from_array(resolver.province_address(host.key()).map_err(|e| format!("province: {e:?}"))?);
        let _ = program;
        Ok(Fixture {
            season: base.season,
            host,
            citizen,
            holding,
            home: home_key,
            frontier: base.frontier,
            ring_seed: base.ring_seed,
            home_ring: base.home_ring,
            genesis_ts: base.genesis_ts,
            genesis_round: base.genesis_round,
            rent_payer,
            accounts: vec![
                (base.season, base.data(&base.season).to_vec()),
                (citizen, cd),
                (holding, h),
                (home_key, home),
                (base.frontier, base.data(&base.frontier).to_vec()),
                (base.ring_seed, base.data(&base.ring_seed).to_vec()),
                // SYNTHETIC JoinShard poststate (see the Citizen above)
                (join_shard, js),
            ],
        })
    }

    /// Writes the owner records: the Citizen, the Holding and the home with
    /// its holding mirror and roster entry (the Season, Frontier and RingSeed
    /// stay as the base and the program left them).
    pub fn install(&self, c: &mut Chain) -> Result<(), String> {
        for (key, data) in self.accounts[1..4].iter().chain(self.accounts[6..].iter()) {
            let a = Account { lamports: FIXTURE_LAMPORTS, data: data.clone(), owner: Address::new_from_array(PROGRAM), executable: false };
            let a = match c.account(key) {
                // the home keeps the lamports the program funded it with
                Some(old) if *key == self.home => Account { lamports: old.lamports, ..a },
                _ => a,
            };
            c.set_account(*key, a)?;
        }
        // the Holding's rent payer: a live system wallet funded by the faucet
        c.airdrop(&self.rent_payer, RENT_PAYER_LAMPORTS)?;
        Ok(())
    }
}

/// A running local play node.
pub struct Play {
    pub running: server::Running,
    pub metadata: Value,
    /// The installed first world (public facts only).
    pub fixture: Fixture,
    /// The wide-destination plan (holds the in-memory test authority; no
    /// Debug, never printed), when requested.
    pub wide: Option<crate::wide_destination::Plan>,
}

/// `--max-len` of a deploy: round_up(1.25 × .so, 4 KiB), as the build script.
fn max_len(len: usize) -> usize {
    (len * 5).div_ceil(4).div_ceil(4096) * 4096
}

/// Starts the node, after the same port and wallet checks as the command
/// line (explicit, distinct, free, 41000–41999, never 41970; a usable public
/// key), whoever calls it.
pub async fn launch(artifact: &Artifact, wallet: Address, rpc_port: u16, ws_port: u16) -> Result<Play, String> {
    launch_with(artifact, wallet, rpc_port, ws_port, false).await
}

/// As [`launch`]; `keeper` only states in the metadata that the caller will
/// run the opt-in keeper loop on this node (it is started by the binary).
pub async fn launch_with(artifact: &Artifact, wallet: Address, rpc_port: u16, ws_port: u16, keeper: bool) -> Result<Play, String> {
    launch_full(artifact, wallet, rpc_port, ws_port, keeper, false).await
}

/// [`launch_with`], optionally with the wide-destination fixture: the
/// SYNTHETIC Season authority and requested ring-129 record are installed
/// at bootstrap; the REAL instructions run later (`wide_destination::run`).
pub async fn launch_full(artifact: &Artifact, wallet: Address, rpc_port: u16, ws_port: u16, keeper: bool, wide: bool) -> Result<Play, String> {
    check_ports(rpc_port, ws_port)?;
    check_wallet(&wallet)?;
    if localnet::bls_and_sbpf_v2_active() != (true, true) {
        return Err("the node's feature set lacks the BLS12-381 syscalls or SBPF v2".into());
    }
    let cfg = Config { allow_tamper: false, data_dir: None, ..Config::default() };
    let mut c = Chain::new(cfg);
    let program = Address::new_from_array(PROGRAM);
    c.deploy(program, &artifact.bytes, max_len(artifact.bytes.len()), None)?;
    c.airdrop(&wallet, PLAYER_LAMPORTS)?;
    c.produce_block();
    let mut base = Base::new(c.unix_timestamp())?;
    let authority = wide.then(fclient::Keypair::new);
    if let Some(k) = &authority {
        base.set_authority(&fclient::Signer::pubkey(k));
    }
    base.install(&mut c)?;
    c.produce_block();
    let (opened, open_signature) = open_home(&mut c)?;
    let fixture = Fixture::new(&wallet, &base, &opened)?;
    fixture.install(&mut c)?;
    c.produce_block();
    let wide_plan = match authority {
        Some(k) => {
            let now = c.unix_timestamp();
            let season_bytes = c.account(&base.season).ok_or("no Season")?.data;
            let legacy = c.account(&base.ring_seed).ok_or("no ring-128 seed")?.data;
            let (key, data, round) = crate::wide_destination::requested_ring_seed(&base.season, &season_bytes, &legacy, now, &fclient::Signer::pubkey(&k))?;
            if c.account(&key).is_some() {
                return Err("the ring-129 seed already exists".into());
            }
            c.set_account(key, Account { lamports: FIXTURE_LAMPORTS, data, owner: program, executable: false })?;
            c.produce_block();
            Some(crate::wide_destination::Plan::new(k, base.season, round, now))
        }
        None => None,
    };
    let slot = c.slot();
    let now = c.unix_timestamp();
    // taken before the chain moves behind the lock; equals the served
    // `getSignatureStatuses` context.instance
    let runner_instance = hex::encode(c.status_instance());
    let state = Arc::new(Mutex::new(c));
    let running = server::start_with_policy(state, rpc_port, ws_port, server::Policy::MEMORY_ONLY).await?;
    let metadata = json!({
        "schema": SCHEMA,
        "rpc_url": running.url(),
        "ws_url": running.ws_url(),
        "listen": "127.0.0.1 only",
        "runner_instance": runner_instance,
        "program": program.to_string(),
        "program_version": format!("0x{PROGRAM_VERSION:04x}"),
        "artifact": {"path": artifact.path.display().to_string(), "sha256": artifact.sha256, "marker": "PSF_LOCALNET_EXPEDITION_SBF_BUILD", "bytes": artifact.bytes.len()},
        "execution": "real SBF artifact in the in-process LiteSVM chain (BLS12-381 syscalls and SBPF v2 active)",
        "player_wallet": wallet.to_string(),
        "season": fixture.season.to_string(),
        "season_id": SEASON_ID,
        "genesis_ts": fixture.genesis_ts,
        "bell_secs": BELL_SECS,
        "host": hex::encode(fixture.host.to_bytes()),
        "accounts": {"citizen": fixture.citizen.to_string(), "holding": fixture.holding.to_string(), "home_province": fixture.home.to_string(),
            "frontier": fixture.frontier.to_string(), "ring_seed": fixture.ring_seed.to_string()},
        "home_ring": fixture.home_ring,
        "genesis_round": fixture.genesis_round,
        "season_params": "S1_LOCAL_7D preset (Quicknet beacon) as CreateSeason writes it; overrides: status Running, program_version 0x4804, r_max 128 with no ceiling, genesis aligned to a real Quicknet round; genesis seed zero",
        "synthetic_map": "Frontier rings_opened = home ring + 1 and one Province; only the home ring has a RingSeed, SEEDED with a ZERO seed and round 0 (not a beacon value) from which OpenProvince derived the home terrain; rings 0..home ring have no Province",
        "bootstrap": {"slot": slot, "unix_timestamp": now, "player_airdrop_lamports": PLAYER_LAMPORTS},
        "initial_world": "the home Province (128, 0) was opened by the REAL OpenProvince instruction (terrain from the synthetic zero RingSeed, keep, camp, resolved_next = opened_bell = the bell then); the Season, Frontier, RingSeed and ProvinceFund before it, and the Citizen, Holding, the home's holding site mirror and roster entry after it, are SYNTHETIC (Chain::set_account); no CreateSeason/OpenRing/Join/PlaceHome/ticket/Muster instruction ran; the synthetic Citizen carries the resident poststate Join + PlaceHome would leave (JOINED | FIRST_HOLDING_FINAL | HOME_GRANTED, holdings_n 1, no ticket, unused slots gen 0xFF, faction 0 as the Holding, mirror and roster)",
        "open_province_signature": open_signature,
        "persistence": "memory only (no data_dir)",
        "tamper_rpc": false,
        "rpc_policy": "memory-only: frontier_snapshot, frontier_restore and frontier_setAccount refused before any parameter is read",
        "time_control_rpc": ["frontier_pause", "frontier_resume", "frontier_setScale", "frontier_hold", "frontier_release"],
        "automatic_send": false,
        "keys": "the player signs with its own wallet; one fresh in-memory fee payer paid OpenProvince at bootstrap (never stored or printed); no key is read",
        "holding_rent_payer": format!("SYNTHETIC: the Holding's RENT_PAYER is {}, a fresh in-memory test key (secret dropped at creation, never stored or printed) funded by the node's faucet with {RENT_PAYER_LAMPORTS} lamports, standing in for the PlaceHome fee payer that did not run", fixture.rent_payer),
        "keeper": if keeper { json!({"mode": KEEPER_PUBLIC_QUICKNET, "source": crate::local_keeper::DRAND_URL,
            "does": "PostAnchor of ended bells with public Quicknet rounds verified against the pinned key, then FastForward of the home as far as closed reveal windows prove; while a bell is not quiet after a Depart, the origin driver takes one real step per tick (GatherClash, PostSeed, ResolveFromInputs, SettleOrigin); after the player's own Reveal has landed, the destination driver takes one real step per tick (destination anchors are the keeper's; ExpeditionGather, PostSeed, Resolve, then the member settlement for a Stays/Retreated fate only; any other fate stops it, named, unsettled); stops safely on any program refusal or unknown outcome",
            "clock": "natural 1x (no block produced, no time changed)", "fee_payer": "fresh in-memory key, faucet-funded"}) } else { Value::Null },
        "wide_destination": match &wide_plan {
            Some(w) => json!({"mode": crate::wide_destination::MODE, "dest": [crate::wide_destination::DEST.0, crate::wide_destination::DEST.1],
                "season_authority": w.authority().to_string(), "bound_round": w.round, "t_open": w.t_open,
                "synthetic": crate::wide_destination::synthetic_note(w.t_open, w.round),
                "then": "WideConsumeRingSeed, WideSetRules, WideOpenProvince run in order once the bound round is published (about 11 minutes); each landed on this node's ticker; a refusal or unknown outcome stops the task"}),
            None => Value::Null,
        },
        "services_not_started": if keeper { json!(["herald", "gateway", "relay", "the Reveal (the player's own transaction)", "terminal settlements other than the member path"]) } else { json!(["keeper", "herald", "gateway", "relay", "beacon"]) },
    });
    let fixture = fixture;
    Ok(Play { running, metadata, fixture, wide: wide_plan })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(rpc: &str, ws: &str) -> Vec<String> {
        [
            "--artifact", "/tmp/x.so",
            "--artifact-sha256", &"ab".repeat(32),
            "--player-wallet", &Address::new_from_array([7; 32]).to_string(),
            "--rpc-port", rpc,
            "--ws-port", ws,
        ]
        .map(String::from)
        .to_vec()
    }
    /// A port in 41000–41999 that is free right now (held only by this test
    /// while it checks), or `None` if every candidate is taken.
    /// Each test scans its own band so parallel tests never race for a port.
    fn free_port_in(from: u16) -> Option<u16> {
        (from..from + 15).filter(|p| *p != REFUSED_PORT).find(|p| server::check_port(*p).is_ok())
    }
    fn free_port() -> Option<u16> {
        free_port_in(41_900)
    }
    /// The next free port in the same band as `p`.
    fn free_after(p: u16) -> u16 {
        (p + 1..p + 15).find(|x| *x != REFUSED_PORT && server::check_port(*x).is_ok()).unwrap()
    }

    #[test]
    fn the_wide_destination_flag_is_opt_in_and_exact() {
        let Some(p) = free_port_in(41_915) else { return };
        let q = free_after(p);
        let base = args(&p.to_string(), &q.to_string());
        assert!(!parse_args(base.clone()).unwrap().wide_destination, "off by default");
        let with = |extra: &[&str]| { let mut v = base.clone(); v.extend(extra.iter().map(|s| s.to_string())); parse_args(v) };
        assert!(with(&["--wide-destination", "public-quicknet"]).unwrap().wide_destination);
        assert!(with(&["--wide-destination", "other"]).is_err());
        assert!(with(&["--wide-destination"]).is_err());
        assert!(with(&["--wide-destination", "public-quicknet", "--wide-destination", "public-quicknet"]).is_err());
        let both = with(&["--keeper", "public-quicknet", "--wide-destination", "public-quicknet"]).unwrap();
        assert!(both.keeper && both.wide_destination);
    }

    #[test]
    fn arguments_and_ports_are_strict() {
        let Some(p) = free_port() else { return };
        let q = free_after(p);
        let o = parse_args(args(&p.to_string(), &q.to_string())).unwrap();
        assert_eq!((o.rpc_port, o.ws_port), (p, q));
        for (rpc, ws) in [
            ("41970", &q.to_string()[..]),
            (&p.to_string()[..], "41970"),
            ("0", &q.to_string()[..]),
            (&p.to_string()[..], &p.to_string()[..]),
            ("8899", &q.to_string()[..]),
            // reserved by the node itself
            ("18899", &q.to_string()[..]),
            ("041900", &q.to_string()[..]),
            ("x", &q.to_string()[..]),
        ] {
            assert!(parse_args(args(rpc, ws)).is_err(), "{rpc} {ws}");
        }
        let mut relative = args(&p.to_string(), &q.to_string());
        relative[1] = "x.so".into();
        assert!(parse_args(relative).is_err());
        let mut short = args(&p.to_string(), &q.to_string());
        short[3] = "ab".into();
        assert!(parse_args(short).is_err());
        let mut wallet = args(&p.to_string(), &q.to_string());
        wallet[5] = "not-a-key".into();
        assert!(parse_args(wallet).is_err());
        let mut dup = args(&p.to_string(), &q.to_string());
        dup[8] = "--rpc-port".into();
        assert!(parse_args(dup).is_err());
        let mut extra = args(&p.to_string(), &q.to_string());
        extra.extend(["--allow-tamper".into(), "1".into()]);
        assert!(parse_args(extra).is_err());
    }

    #[test]
    fn a_port_another_listener_holds_is_refused_and_left_alone() {
        let Some(p) = free_port_in(41920) else { return };
        let held = std::net::TcpListener::bind(("127.0.0.1", p)).unwrap();
        let q = free_after(p);
        assert!(check_ports(p, q).unwrap_err().contains("busy"));
        // the other listener still owns it
        assert_eq!(held.local_addr().unwrap().port(), p);
    }

    /// `launch` applies the same checks itself, before reading the artifact
    /// into a chain or binding anything.
    #[test]
    fn launch_refuses_bad_ports_and_wallets_itself() {
        let Some(p) = free_port_in(41940) else { return };
        let q = free_after(p);
        let mut elf = vec![0u8; 128];
        elf[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        elf[48] = 2;
        elf[64..64 + MARKER.len()].copy_from_slice(MARKER);
        let sha = hex::encode(Sha256::digest(&elf));
        let a = inspect("/a".into(), elf, &sha).unwrap();
        let w = Address::new_from_array([7; 32]);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for (rpc, ws, wallet) in [
            (REFUSED_PORT, q, w),
            (p, REFUSED_PORT, w),
            (0, 0, w),
            (p, p, w),
            (8899, q, w),
            (p, q, Address::default()),
            (p, q, Address::new_from_array(PROGRAM)),
        ] {
            let r = rt.block_on(launch(&a, wallet, rpc, ws));
            assert!(r.is_err(), "{rpc} {ws} {wallet}");
        }
        // nothing was bound by the refused attempts
        assert!(server::check_port(p).is_ok() && server::check_port(q).is_ok());
    }

    #[test]
    fn the_artifact_checks_refuse_what_is_not_the_named_build() {
        let mut elf = vec![0u8; 128];
        elf[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        elf[48] = 2;
        elf[64..64 + MARKER.len()].copy_from_slice(MARKER);
        let sha = hex::encode(Sha256::digest(&elf));
        assert!(inspect("/a".into(), elf.clone(), &sha).is_ok());
        assert!(inspect("/a".into(), elf.clone(), &"00".repeat(32)).is_err());
        let mut v1 = elf.clone();
        v1[48] = 1;
        assert!(inspect("/a".into(), v1.clone(), &hex::encode(Sha256::digest(&v1))).is_err());
        let mut unmarked = elf.clone();
        unmarked[64] ^= 1;
        assert!(inspect("/a".into(), unmarked.clone(), &hex::encode(Sha256::digest(&unmarked))).is_err());
        assert!(inspect("/a".into(), vec![1; 128], &sha).is_err());
    }

    #[test]
    fn the_fixture_is_owned_by_the_given_public_wallet() {
        let wallet = Address::new_from_array([7; 32]);
        let base = Base::new(1_785_600_000).unwrap();
        // a stand-in for the bytes OpenProvince writes (the real ones come from
        // the program in the ignored artifact tests): two sites, site 0 taken
        let mut opened = header_bytes(P::SIZE, P::MAGIC);
        assert!(wr_i16(&mut opened, P::P, 128));
        opened[P::SITE_COUNT] = 2;
        opened[P::SITES] = 17;
        opened[P::SITES + 1] = 33;
        opened[P::site(0) + SM::STATE] = SM1::STATE_HOLDING;
        let f = Fixture::new(&wallet, &base, &opened).unwrap();
        assert_eq!((f.host.site(), f.host.gen()), (1, 2), "the first FREE site");
        let citizen = &f.accounts[1].1;
        assert_eq!(&citizen[C::WALLET..C::WALLET + 32], wallet.as_ref());
        let h = &f.accounts[2].1;
        assert_eq!(&h[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], f.citizen.as_ref());
        assert_eq!((h[H::SITE], h[H::TILE]), (1, 33), "the holding sits on the site's real tile");
        // the rent payer is the fresh funding wallet, never zero (= the
        // executable System Program, refused by every refund to it)
        assert_eq!(&h[H::RENT_PAYER..H::RENT_PAYER + 32], f.rent_payer.as_ref());
        assert_ne!(f.rent_payer, Address::new_from_array([0; 32]));
        assert_ne!(f.rent_payer, wallet);
        assert_ne!(Fixture::new(&wallet, &base, &opened).unwrap().rent_payer, f.rent_payer, "fresh per fixture");
        let home = &f.accounts[3].1;
        assert_eq!((home[P::site(1) + SM::STATE], home[P::site(1) + SM::GEN]), (SM1::STATE_HOLDING, 2));
        // a NEUTRAL faction left by OpenProvince on the free site becomes the owner's 0
        let mut neutral = opened.clone();
        neutral[P::site(1) + SM::FACTION] = 0xff;
        let g = Fixture::new(&wallet, &base, &neutral).unwrap();
        assert_eq!((g.accounts[3].1[P::site(1) + SM::FACTION], g.accounts[3].1[P::site(1) + SM::ORDER]), (0, 1));
        // the Citizen is in the resident poststate of Join + PlaceHome, so a
        // reader gating on it (web/frontier/fland.mjs landState) sees a FINAL
        // first holding, not an open ticket
        assert_eq!(citizen[C::FLAGS], C::FLAG_JOINED | C::FLAG_FIRST_HOLDING_FINAL | C::FLAG_HOME_GRANTED);
        assert_eq!(citizen[C::FLAGS] & (C::FLAG_PROVISIONAL | C::FLAG_REFUGEE), 0);
        assert_eq!(citizen[C::HOLDINGS_N], 1);
        assert_eq!(u32::from_le_bytes(citizen[C::TICKET_BELL..C::TICKET_BELL + 4].try_into().unwrap()), C::NO_TICKET);
        let s1 = C::holding_of_slot(1);
        assert_eq!((i16::from_le_bytes([citizen[s1 + HR::P], citizen[s1 + HR::P + 1]]), citizen[s1 + HR::SITE], citizen[s1 + HR::GEN]), (128, 1, 2));
        for unused in 2..=3u8 {
            let o = C::holding_of_slot(unused);
            assert_eq!(citizen[o + HR::GEN], C::EMPTY_GEN, "slot {unused} is empty (gen 0xFF), not gen 0");
            assert!(citizen[o..o + HR::GEN].iter().all(|&b| b == 0));
        }
        // one faction across the Citizen, the Holding, the mirror and the roster
        assert_eq!((citizen[C::FACTION], h[H::FACTION], home[P::site(1) + SM::FACTION]), (FACTION, FACTION, FACTION));
        assert_eq!(u32::from_le_bytes(h[H::TICKET_BELL..H::TICKET_BELL + 4].try_into().unwrap()), C::NO_TICKET);
        let e = frontier_abi::entry::read_entry(home, 0).unwrap();
        assert_eq!(e.faction, FACTION);
        assert_eq!((e.tile, e.troops), (33, 12_000));
        let s = fclient::decode::Season::decode(&f.accounts[0].1).unwrap();
        assert_eq!(s.program_version, PROGRAM_VERSION);
        assert_eq!(s.ruleset_hash, RULESET_HASH_V3);
        assert_eq!(f.season, fclient::addr::season_pda(&Address::new_from_array(PROGRAM), SEASON_ID).0);
        // a real Quicknet beacon, as the browser's seal pin checks it
        let q = fclient::beacon::quicknet_info();
        assert_eq!(f.accounts[0].1[S::NETWORK], S::NETWORK_QUICKNET);
        assert_eq!(s.quicknet_pk_hash, <[u8; 32]>::from(Sha256::digest(q.public_key)));
        assert_eq!((s.drand_genesis, s.drand_period as u64), (q.genesis_time as i64, q.period as u64));
        assert!(s.seed_margin > 0 && s.reveal_window > 0);
        assert_eq!(s.r_max, 128);
        assert_eq!(fclient::clock::SeasonClock::from_season(&s).bell_at(1_785_600_000), Some(10));
        let fr = fclient::decode::Frontier::decode(&f.accounts[4].1).unwrap();
        assert_eq!((fr.rings_opened, f.home_ring), (129, 128));
        assert_eq!(f.accounts[5].1[RS::STATUS], RS::STATUS_SEEDED);
        assert_eq!(&f.accounts[5].1[RS::SEED..RS::SEED + 32], &[0u8; 32], "a zero seed, not a beacon value");
        // no free site: refused
        opened[P::site(1) + SM::STATE] = SM1::STATE_HOLDING;
        assert!(Fixture::new(&wallet, &base, &opened).is_err());
    }


    /// With the real artifact (`WYLLS_EXPEDITION_SBF` = absolute path,
    /// `WYLLS_EXPEDITION_SBF_SHA256` = its digest): start on two free loopback
    /// ports, read the program and the fixture back over the node's own RPC,
    /// stop, and the ports are released. No transaction is sent.
    #[test]
    #[ignore]
    fn the_real_artifact_starts_serves_and_stops() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        let path = PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        assert!(path.is_absolute());
        let artifact = inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let wallet = Address::new_from_array([7; 32]);
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let p = free_port_in(41_955).expect("a free port in 41955-41969");
            let q = free_after(p);
            let play = launch(&artifact, wallet, p, q).await.unwrap();
            assert_eq!((play.running.addr.port(), play.running.ws_addr.port()), (p, q));
            let addr = play.running.addr;
            assert!(addr.ip().is_loopback() && play.running.ws_addr.ip().is_loopback());
            let rpc = fclient::rpc::RpcClient::new(play.running.url());
            let program = rpc.call("getAccountInfo", json!([Address::new_from_array(PROGRAM).to_string(), {"encoding": "base64"}])).await.unwrap();
            assert_eq!(program["value"]["executable"], true, "{program}");
            let season = play.metadata["season"].as_str().unwrap().to_owned();
            let s = rpc.call("getAccountInfo", json!([season, {"encoding": "base64"}])).await.unwrap();
            assert_eq!(s["value"]["owner"], Address::new_from_array(PROGRAM).to_string());
            let bal = rpc.call("getBalance", json!([wallet.to_string()])).await.unwrap();
            assert_eq!(bal["value"], PLAYER_LAMPORTS);
            // tamper, snapshot-to-path and restore are refused by the policy,
            // with no file written and the Season account unchanged
            let path = std::env::temp_dir().join(format!("expedition-play-never-{}.snap", std::process::id()));
            for (method, params) in [
                ("frontier_setAccount", json!([season, null])),
                ("frontier_snapshot", json!([path.to_str().unwrap()])),
                ("frontier_restore", json!([path.to_str().unwrap()])),
            ] {
                let r = rpc.call(method, params).await;
                assert!(r.is_err(), "{method}: {r:?}");
            }
            assert!(!path.exists());
            // (the slot ticker keeps running, so the whole-state hash moves;
            // the refused targets' accounts are compared instead)
            let s2 = rpc.call("getAccountInfo", json!([season, {"encoding": "base64"}])).await.unwrap();
            assert_eq!(s2["value"]["data"], s["value"]["data"]);
            assert_eq!(play.metadata["tamper_rpc"], false);
            assert_eq!(play.metadata["automatic_send"], false);
            play.running.stop();
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert!(tokio::net::TcpStream::connect(addr).await.is_err(), "the RPC port is released");
        });
    }
}

/// With the real artifact: the new first world (S1 preset Season, Frontier,
/// RingSeed, home ring 128) still takes a REAL signed Depart carrying a REAL
/// wide seal (fresh key, stock tlock to T(arrive) under the real Quicknet
/// key) on the real SBF program. The wallet is an in-memory test keypair:
/// nothing is printed or stored. Ignored without the artifact variables.
#[cfg(test)]
mod real_depart {
    use super::*;
    use fclient::experimental_expedition_message::{prepare_depart, Target, DEPART_HEAP_FRAME};
    use fclient::original_expedition_depart_draft::Draft;
    use fclient::tx::{self, TxBudget};
    use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
    use fclient::{Keypair, Signer};
    use frontier_abi::world_index::{seal::WidePlain, ProvinceKey, WideCoord};

    #[test]
    #[ignore]
    fn the_new_first_world_takes_a_real_signed_depart_with_a_real_wide_seal() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        let path = PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let artifact = inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let kp = Keypair::new();
        let wallet = kp.pubkey();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let p = (41_975..41_990u16).find(|p| *p != REFUSED_PORT && server::check_port(*p).is_ok()).unwrap();
            let q = (p + 1..41_999u16).find(|x| *x != REFUSED_PORT && server::check_port(*x).is_ok()).unwrap();
            let play = launch(&artifact, wallet, p, q).await.unwrap();
            let f = &play.fixture;
            let program = Address::new_from_array(PROGRAM);
            let outcome = {
                let mut c = server::lock(&play.running.state);
                let sd = c.account(&f.season).unwrap().data;
                let season = fclient::decode::Season::decode(&sd).unwrap();
                let clock = fclient::clock::SeasonClock::from_season(&season);
                let bell = clock.bell_at(c.unix_timestamp()).unwrap();
                // the home is the program's OpenProvince output: real terrain and sites,
                // resolved_next = opened_bell = the bell it opened at
                let home = fclient::decode::Province::decode(&c.account(&f.home).unwrap().data).unwrap();
                assert!(home.passable_mask != 0 && home.site_count > 0, "terrain and sites from OpenProvince");
                assert_eq!(home.resolved_next, bell);
                assert_eq!(home.sites[f.host.site() as usize], c.account(&f.holding).unwrap().data[H::TILE]);
                eprintln!("home (128,0): site_count {}, passable bits {}, resolved_next {}", home.site_count, home.passable_mask.count_ones(), home.resolved_next);
                let arrive = bell + 5;
                let tip = fclient::fees::min_tip_lamports(season.min_reveal_priority_milli, season.reveal_cu_limit, season.reveal_loaded_limit);
                let (path_len, path_bits) = permutation_rules::frontier::seal::encode_path(&[0]).unwrap();
                let plain = WidePlain {
                    version: frontier_abi::world_index::seal::WIDE_PLAIN_VERSION,
                    host: f.host,
                    arrive_bell: arrive,
                    dest: ProvinceKey::new(f.host.key().world(), WideCoord::checked(129, 0).unwrap()),
                    dest_tile: 30,
                    stance: 0,
                    retreat_bps: 0,
                    path_len,
                    path: path_bits,
                    reserved: [0; frontier_abi::world_index::seal::WIDE_RESERVED_BYTES],
                };
                let q = fclient::beacon::quicknet_info();
                let sealed = fclient::wide_seal::seal_wide(&plain, &f.host, arrive, &q.public_key, clock.tlock_round(arrive)).unwrap();
                let ctx = AddrCtx { program: PROGRAM, season: f.season.to_bytes() };
                let draft = Draft::for_wallet(&ctx, f.host, f.host.key(), wallet, wallet, 0, arrive, tip, sealed.commit, sealed.seal).unwrap();
                let (blockhash, last_valid) = c.latest_blockhash();
                let observation = BlockhashObservation { blockhash: blockhash.to_bytes(), context_slot: c.slot(), valid: true, block_height: last_valid.saturating_sub(100), last_valid_block_height: last_valid };
                let budget = TxBudget { cu_limit: 1_000_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(DEPART_HEAP_FRAME) };
                let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
                let prepared = prepare_depart(&draft, Target { program, season: f.season, program_version: PROGRAM_VERSION }, observation, budget, limits).unwrap();
                let t = tx::sign(prepared.message().clone(), &[&kp]).unwrap();
                let sig = c.submit(&tx::wire(&t)).unwrap();
                c.produce_block();
                let landed = c.transaction(&sig).cloned().expect("landed");
                let holding = c.account(&f.holding).unwrap().data;
                (landed.err, landed.code, holding, sealed.ct_hash)
            };
            play.running.stop();
            let (err, code, holding, ct_hash) = outcome;
            assert_eq!(err, None, "the real program refused the Depart: code {code:?}");
            // the Holding now carries the escrow of the departure
            let escrow = u64::from_le_bytes(holding[frontier_abi::layout::player::holding::ESCROW..][..8].try_into().unwrap());
            assert!(escrow > 0);
            let _ = ct_hash;
        });
    }
}
