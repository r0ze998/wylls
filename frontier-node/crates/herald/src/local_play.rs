//! **Opt-in local-play bootstrap** (feature `local-play-bootstrap`, flag
//! `--local-play-metadata FILE`): shows the temporary local-play chain's
//! SYNTHETIC first world in the herald's ordinary views.
//!
//! Why: that runner writes its first Season, Citizen, Holding and home
//! Province with `Chain::set_account` (ledger mutations, not program
//! transactions), and the ingest folds transaction records only, so those
//! four accounts would never appear.
//!
//! What it does, once, before ingest starts:
//! - reads the runner's public metadata (`frontier-localnet-expedition-play-v1`):
//!   program, Season, wallet and the six account addresses (Season,
//!   Citizen, Holding, home Province, Frontier, the home ring's RingSeed); the program
//!   must be the dedicated `[0x45; 32]`, the Season id and RPC URL the
//!   herald's own;
//! - reads the program, its ProgramData and those six accounts in ONE
//!   `getMultipleAccounts` (one context slot) from that RPC, in a fixed order
//!   whose keys are checked one by one (no reordering, no duplicate);
//! - checks: the program account is the executable LoaderV3 program whose
//!   ProgramData holds exactly the runner's artifact (SHA-256 of the ELF
//!   bytes equal to the metadata's digest, zero padding after); every account is owned by
//!   the program, not executable, the exact v2 layout of its kind for this
//!   Season; the Season is the program's Season PDA with its stored bump,
//!   version `0x4804`, the S1 ruleset hash (`RULESET_HASH_V3`) and the real
//!   Quicknet beacon (NETWORK 2, the public key's hash, drand genesis and
//!   period, a reveal window and seed margin); the home Province's ring,
//!   wedge and region are its coordinates'; the Frontier has the home ring
//!   opened; the home ring's RingSeed is seeded (its seed is the runner's
//!   synthetic zero seed, reported as such, never as a beacon value); the Citizen is the wallet's Citizen and stores that
//!   wallet; the Holding is owned by that Citizen, at its canonical address,
//!   and bound in the Citizen's slot of its `order`; the home Province is the
//!   Holding's (P, Q) at its canonical address;
//! - inserts them as captures at that context slot (`tx` 0: before any
//!   archived transaction) into an EMPTY fold and rebuilds the derived
//!   indexes with `Fold::with_state`.
//!
//! It fabricates nothing else: no CreateSeason/Join record, event, receipt
//! or transaction; `/h/events` stays empty until real transactions land,
//! and `/h/status` says where the first state came from. Live program
//! transactions are then folded by the normal `frontier_feed` ingest, which
//! replaces these captures with their post-states. The herald's data
//! directory must be new or empty (public data only; no key anywhere).
use fclient::decode::{Citizen, Holding, Province, Season};
use fclient::Address;
use frontier_abi::v2::layout::AccountKind;
use frontier_abi::v2::presets::RULESET_HASH_V3;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::fold::{Capture, Fold};
use frontier_abi::layout::world::ring_seed as RS;
use permutation_rules::frontier::geometry::{region_of, ProvinceCoord};

pub const METADATA_SCHEMA: &str = "frontier-localnet-expedition-play-v1";
pub const PROGRAM: [u8; 32] = [0x45; 32];
pub const PROGRAM_VERSION: u16 = 0x4804;
/// The usual stack's port: never used by a local-play herald.
pub const REFUSED_PORT: u16 = 41970;
/// LoaderV3 ProgramData header bytes before the ELF.
const PROGRAMDATA_META: usize = 45;

fn local_port(p: u16) -> Result<u16, String> {
    if p == 0 || p == REFUSED_PORT || !crate::port_allowed(p) {
        return Err(format!(
            "port {p}: a local-play herald uses 41000-41999 (never 41970 or a reserved port)"
        ));
    }
    Ok(p)
}

/// The RPC URL is exactly `http://127.0.0.1:PORT` (no userinfo, path, query
/// or fragment; a canonical allowed port).
pub fn loopback_rpc(url: &str) -> Result<u16, String> {
    let port = url
        .strip_prefix("http://127.0.0.1:")
        .ok_or("--rpc must be http://127.0.0.1:PORT")?;
    let p: u16 = port
        .parse()
        .map_err(|_| "--rpc must be http://127.0.0.1:PORT (nothing after the port)")?;
    if p.to_string() != port {
        return Err("--rpc: not a canonical port".into());
    }
    local_port(p)
}

/// The listen address is `127.0.0.1:PORT`, an allowed port, never 41970.
pub fn loopback_listen(listen: &str) -> Result<u16, String> {
    let a: std::net::SocketAddr = listen
        .parse()
        .map_err(|_| "--listen must be 127.0.0.1:PORT")?;
    if a.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) || a.to_string() != listen {
        return Err("--listen must be 127.0.0.1:PORT".into());
    }
    local_port(a.port())
}

/// What the runner said it created (public facts only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Expected {
    pub program: Address,
    pub season_id: u64,
    pub season: Address,
    pub wallet: Address,
    pub citizen: Address,
    pub holding: Address,
    pub home: Address,
    pub frontier: Address,
    pub ring_seed: Address,
    /// The runner's artifact: SHA-256 (lowercase hex) and length of the ELF.
    pub artifact_sha256: String,
    pub artifact_len: usize,
}

fn addr(v: &Value, what: &str) -> Result<Address, String> {
    let s = v.as_str().ok_or(format!("metadata: {what} missing"))?;
    let a: Address = s
        .parse()
        .map_err(|_| format!("metadata: {what} is not an address"))?;
    if a.to_string() != s {
        return Err(format!("metadata: {what} is not canonical"));
    }
    Ok(a)
}

/// The runner's metadata, checked against the herald's own `--program`,
/// `--season` and `--rpc`.
pub fn expected(
    metadata: &str,
    program: &Address,
    season_id: u64,
    rpc: &str,
) -> Result<Expected, String> {
    let v: Value = serde_json::from_str(metadata.trim()).map_err(|e| format!("metadata: {e}"))?;
    if v["schema"] != METADATA_SCHEMA {
        return Err(format!("metadata: schema is not {METADATA_SCHEMA}"));
    }
    let e = Expected {
        program: addr(&v["program"], "program")?,
        season_id: v["season_id"].as_u64().ok_or("metadata: season_id")?,
        season: addr(&v["season"], "season")?,
        wallet: addr(&v["player_wallet"], "player_wallet")?,
        citizen: addr(&v["accounts"]["citizen"], "citizen")?,
        holding: addr(&v["accounts"]["holding"], "holding")?,
        home: addr(&v["accounts"]["home_province"], "home_province")?,
        frontier: addr(&v["accounts"]["frontier"], "frontier")?,
        ring_seed: addr(&v["accounts"]["ring_seed"], "ring_seed")?,
        artifact_sha256: v["artifact"]["sha256"]
            .as_str()
            .ok_or("metadata: artifact.sha256")?
            .to_owned(),
        artifact_len: v["artifact"]["bytes"]
            .as_u64()
            .ok_or("metadata: artifact.bytes")? as usize,
    };
    if e.artifact_sha256.len() != 64
        || !e
            .artifact_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || e.artifact_len == 0
    {
        return Err("metadata: artifact digest/length".into());
    }
    if e.program.to_bytes() != PROGRAM || e.program != *program {
        return Err("metadata: not the dedicated local-play program, or not --program".into());
    }
    if e.season_id != season_id {
        return Err("metadata: season_id is not --season".into());
    }
    if v["rpc_url"].as_str() != Some(rpc) {
        return Err("metadata: rpc_url is not --rpc (another runner?)".into());
    }
    if v["program_version"] != format!("0x{PROGRAM_VERSION:04x}") {
        return Err("metadata: program_version is not 0x4804".into());
    }
    Ok(e)
}

/// One account as read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Read {
    pub owner: Address,
    pub executable: bool,
    pub data: Vec<u8>,
}

/// The eight accounts of one `getMultipleAccounts`, at one context slot:
/// program, ProgramData, then Season, Citizen, Holding, home Province,
/// Frontier, RingSeed (the keys as requested; `check` matches them against
/// [`Expected`]).
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub context_slot: u64,
    pub program: Option<Read>,
    pub programdata: Option<Read>,
    pub accounts: [(Address, Option<Read>); 6],
}

/// Reads the snapshot from `rpc` (loopback is the caller's rule).
pub async fn read(rpc: &str, e: &Expected) -> Result<Snapshot, String> {
    let keys = [
        e.program,
        fclient::addr::programdata(&e.program),
        e.season,
        e.citizen,
        e.holding,
        e.home,
        e.frontier,
        e.ring_seed,
    ];
    let v = fclient::rpc::RpcClient::new(rpc)
        .call(
            "getMultipleAccounts",
            json!([keys.iter().map(|k| k.to_string()).collect::<Vec<_>>(), {"encoding": "base64", "commitment": "confirmed"}]),
        )
        .await
        .map_err(|e| format!("getMultipleAccounts: {e:?}"))?;
    let context_slot = v["context"]["slot"]
        .as_u64()
        .ok_or("getMultipleAccounts: no context slot")?;
    let values = v["value"]
        .as_array()
        .filter(|a| a.len() == 8)
        .ok_or("getMultipleAccounts: not eight values")?;
    let mut reads = values.iter().map(|a| {
        fclient::rpc::parse_account(a)
            .map(|o| {
                o.map(|a| Read {
                    owner: a.owner,
                    executable: a.executable,
                    data: a.data,
                })
            })
            .map_err(|e| format!("account: {e:?}"))
    });
    let mut next = || reads.next().expect("eight");
    let program = next()?;
    let programdata = next()?;
    Ok(Snapshot {
        context_slot,
        program,
        programdata,
        accounts: [
            (e.season, next()?),
            (e.citizen, next()?),
            (e.holding, next()?),
            (e.home, next()?),
            (e.frontier, next()?),
            (e.ring_seed, next()?),
        ],
    })
}

fn v2<'a>(
    r: &'a Option<Read>,
    program: &Address,
    kind: AccountKind,
    sid: u64,
    what: &str,
) -> Result<&'a [u8], String> {
    let r = r.as_ref().ok_or(format!("{what}: absent"))?;
    if r.owner != *program || r.executable {
        return Err(format!("{what}: not a data account of the program"));
    }
    let d = &r.data;
    // chained kinds carry layout version 2; short kinds (RingSeed) have none
    if d.len() != kind.size()
        || d.get(..8) != Some(kind.magic().as_slice())
        || d.get(8..16)
            .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
            != Some(sid)
        || (kind.chained()
            && d.get(16..18)
                .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
                != Some(2))
    {
        return Err(format!("{what}: not the v2 layout of this Season"));
    }
    Ok(d)
}

/// Every identity and binding check (see the module doc).
pub fn check(e: &Expected, s: &Snapshot) -> Result<(), String> {
    // the exact keys, in order, none repeated
    let want = [
        e.season,
        e.citizen,
        e.holding,
        e.home,
        e.frontier,
        e.ring_seed,
    ];
    if s.accounts.iter().map(|(k, _)| *k).ne(want) {
        return Err("snapshot: not exactly [Season, Citizen, Holding, home Province, Frontier, RingSeed] in order".into());
    }
    if (0..6).any(|i| (i + 1..6).any(|j| want[i] == want[j])) {
        return Err("snapshot: a repeated account".into());
    }
    // the artifact: LoaderV3 program → ProgramData holding exactly its ELF
    let loader: Address = fclient::abi::LOADER_V3.parse().map_err(|_| "loader id")?;
    let pd_key = fclient::addr::programdata(&e.program);
    match &s.program {
        Some(p)
            if p.executable
                && p.owner == loader
                && p.data.len() == 36
                && p.data[..4] == 2u32.to_le_bytes()
                && p.data[4..] == pd_key.to_bytes() => {}
        _ => return Err("the dedicated program is not a LoaderV3 program at this RPC".into()),
    }
    let pd = s
        .programdata
        .as_ref()
        .filter(|p| p.owner == loader && !p.executable)
        .ok_or("ProgramData: absent")?;
    let end = PROGRAMDATA_META
        .checked_add(e.artifact_len)
        .ok_or("artifact length")?;
    let elf = pd
        .data
        .get(PROGRAMDATA_META..end)
        .ok_or("ProgramData: shorter than the artifact")?;
    if pd.data.get(..4) != Some(&3u32.to_le_bytes()[..])
        || hex::encode(Sha256::digest(elf)) != e.artifact_sha256
        || pd.data[end..].iter().any(|b| *b != 0)
    {
        return Err("ProgramData: not exactly the runner's artifact".into());
    }
    let ctx = findex::addr_ctx(&e.program, e.season_id);
    let (pda, bump) = fclient::addr::season_pda(&e.program, e.season_id);
    if pda != e.season || ctx.season != e.season.to_bytes() {
        return Err("Season: not the program's Season PDA".into());
    }
    let sd = v2(
        &s.accounts[0].1,
        &e.program,
        AccountKind::Season,
        e.season_id,
        "Season",
    )?;
    let cd = v2(
        &s.accounts[1].1,
        &e.program,
        AccountKind::Citizen,
        e.season_id,
        "Citizen",
    )?;
    let hd = v2(
        &s.accounts[2].1,
        &e.program,
        AccountKind::Holding,
        e.season_id,
        "Holding",
    )?;
    let pd = v2(
        &s.accounts[3].1,
        &e.program,
        AccountKind::Province,
        e.season_id,
        "home Province",
    )?;
    let fd = v2(
        &s.accounts[4].1,
        &e.program,
        AccountKind::Frontier,
        e.season_id,
        "Frontier",
    )?;
    let rd = v2(
        &s.accounts[5].1,
        &e.program,
        AccountKind::RingSeed,
        e.season_id,
        "RingSeed",
    )?;
    let season = Season::decode(sd).map_err(|_| "Season: does not decode")?;
    if season.bump != bump
        || season.program_version != PROGRAM_VERSION
        || season.ruleset_hash != RULESET_HASH_V3
    {
        return Err("Season: another bump, program version or ruleset".into());
    }
    let q = fclient::beacon::quicknet_info();
    if sd[frontier_abi::v2::layout::world::season::NETWORK]
        != frontier_abi::v2::layout::world::season::NETWORK_QUICKNET
        || season.quicknet_pk_hash != <[u8; 32]>::from(Sha256::digest(q.public_key))
        || season.drand_genesis != q.genesis_time
        || season.drand_period as u64 != q.period as u64
        || season.reveal_window == 0
        || season.seed_margin == 0
    {
        return Err("Season: not the real Quicknet beacon".into());
    }
    let citizen = Citizen::decode(cd).map_err(|_| "Citizen: does not decode")?;
    if Address::new_from_array(ctx.citizen(&e.wallet.to_bytes())) != e.citizen
        || citizen.wallet != e.wallet
    {
        return Err("Citizen: not the wallet's".into());
    }
    let holding = Holding::decode(hd).map_err(|_| "Holding: does not decode")?;
    if holding.owner_citizen != e.citizen
        || Address::new_from_array(ctx.holding(holding.p.into(), holding.q.into(), holding.site))
            != e.holding
    {
        return Err("Holding: not the Citizen's at its canonical address".into());
    }
    let slot = (holding.order as usize)
        .checked_sub(1)
        .and_then(|i| citizen.holding.get(i))
        .ok_or("Holding: no Citizen slot")?;
    if (slot.p, slot.q, slot.site, slot.gen) != (holding.p, holding.q, holding.site, holding.gen) {
        return Err("Citizen: its slot does not bind this Holding".into());
    }
    let home = Province::decode(pd).map_err(|_| "home Province: does not decode")?;
    if (home.p, home.q) != (holding.p, holding.q)
        || Address::new_from_array(ctx.province(holding.p.into(), holding.q.into())) != e.home
    {
        return Err("home Province: not the Holding's".into());
    }
    let coord = ProvinceCoord::new(home.p.into(), home.q.into());
    if u32::from(home.ring) != coord.ring()
        || Some(home.wedge) != coord.wedge()
        || home.region != region_of(coord)
    {
        return Err("home Province: ring, wedge or region is not its coordinates'".into());
    }
    if home.ring > season.r_max {
        return Err("home Province: outside the Season's r_max".into());
    }
    let frontier =
        fclient::decode::Frontier::decode(fd).map_err(|_| "Frontier: does not decode")?;
    if Address::new_from_array(ctx.frontier()) != e.frontier || frontier.rings_opened <= home.ring {
        return Err("Frontier: not the Season's, or the home ring is not opened".into());
    }
    if Address::new_from_array(ctx.ring_seed(home.ring)) != e.ring_seed
        || rd.get(RS::D..RS::D + 2) != Some(&home.ring.to_le_bytes()[..])
        || rd[RS::STATUS] != RS::STATUS_SEEDED
    {
        return Err("RingSeed: not the home ring's seeded RingSeed".into());
    }
    // The provenance below says "zero seed, round 0, not a beacon value":
    // only a RingSeed that really carries exactly that is accepted.
    if rd
        .get(RS::SEED..RS::SEED + 32)
        .is_none_or(|b| b.iter().any(|x| *x != 0))
        || rd
            .get(RS::ROUND..RS::ROUND + 8)
            .is_none_or(|b| b.iter().any(|x| *x != 0))
    {
        return Err("RingSeed: not the runner's synthetic zero seed / round 0".into());
    }
    Ok(())
}

/// Seeds an EMPTY fold with the four checked accounts and rebuilds its
/// indexes. Returns the provenance `/h/status` reports.
pub fn seed(fold: &mut Fold, e: &Expected, s: &Snapshot) -> Result<Value, String> {
    check(e, s)?;
    if fold.st.folded_through != 0 || fold.st.events != 0 || !fold.st.accounts.is_empty() {
        return Err(
            "the fold is not empty: local-play bootstrap needs a new data directory".into(),
        );
    }
    if fold.cfg.program != e.program || fold.cfg.season_id != e.season_id {
        return Err("the herald's program/season is not the runner's".into());
    }
    let mut st = fold.st.clone();
    for (k, r) in &s.accounts {
        let data = r.as_ref().expect("checked").data.clone();
        st.accounts.insert(
            k.to_bytes(),
            Capture {
                slot: s.context_slot,
                tx: 0,
                data,
            },
        );
    }
    // The fold now holds state as of the context slot: its slot watermark says so. Left at 0, the watermark was later
    // raised only by the transactions folded afterwards, and history replayed from before the snapshot (slot 5 under
    // captures of slot 7) left `lastSlot` BELOW the captures it serves: every reader that checks a capture against
    // the snapshot's bounds (the route read's RouteCaptureAhead) refused them, rightly. Never lowered: `apply` keeps
    // the maximum. No transaction, event or sequence is claimed by this: `folded_through` and `events` stay 0.
    st.last_slot = st.last_slot.max(s.context_slot);
    *fold = Fold::with_state(fold.cfg.clone(), fold.out.clone(), st);
    fold.version += 1;
    Ok(json!({
        "source": "synthetic account snapshot of the temporary local-play chain (written with Chain::set_account), read with getMultipleAccounts",
        "contextSlot": s.context_slot,
        "accounts": s.accounts.iter().map(|(k, _)| k.to_string()).collect::<Vec<_>>(),
        "program": e.program.to_string(),
        "programVersion": format!("0x{PROGRAM_VERSION:04x}"),
        "rulesetHash": hex::encode(RULESET_HASH_V3),
        "cluster": "localnet",
        "artifact": {"sha256": e.artifact_sha256, "bytes": e.artifact_len,
            "verified": "the deployed ProgramData's ELF bytes hash to this digest (zero padding after)"},
        "wallet": e.wallet.to_string(),
        "walletBinding": {"citizen": e.citizen.to_string(), "holding": e.holding.to_string(), "homeProvince": e.home.to_string()},
        "map": {"frontier": e.frontier.to_string(), "ringSeed": e.ring_seed.to_string(),
            "ringSeedOrigin": "synthetic: the runner's RingSeed carries a ZERO seed and round 0, not a beacon value"},
        "beacon": "Season pins the real Quicknet key (NETWORK 2, public-key hash, drand genesis/period)",
        "fabricated": "nothing: no CreateSeason/Join record, event, receipt or transaction",
    }))
}

/// The data directory is new or empty (never another herald's archive).
pub fn fresh_data_dir(p: &std::path::Path) -> Result<(), String> {
    match std::fs::read_dir(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("--data: {e}")),
        Ok(mut it) => match it.next() {
            None => Ok(()),
            Some(_) => {
                Err("--data is not empty: local-play bootstrap needs a new data directory".into())
            }
        },
    }
}

#[cfg(test)]
#[path = "local_play_tests.rs"]
mod tests;
