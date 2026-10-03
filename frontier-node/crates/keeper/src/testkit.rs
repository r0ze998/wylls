//! Fakes for the keeper's unit tests (W6T-2): a chain port over an account
//! map that counts its reads and can play a late tick, a drand port over
//! the test key, and builders for the program accounts the duties read.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use solana_address::Address;
use solana_hash::Hash;

use fclient::abi::{layout as l, magic, size};
use fclient::beacon::TestKey;
use fclient::decode::Season;
use fclient::ports::{
    Account, Beacon, ChainInfo, ChainPort, ClockSysvar, Cursor, DrandPort, PortError, PortResult,
    Signature, SimResult, Status, TxRecord,
};
use fclient::tx;

/// A chain port over an account map.
#[derive(Default)]
pub struct FakePort {
    pub accounts: Mutex<HashMap<Address, Account>>,
    pub clock: Mutex<ClockSysvar>,
    /// `accounts()` calls and the keys each asked for.
    pub calls: Mutex<Vec<Vec<Address>>>,
    pub sent: Mutex<Vec<fclient::Transaction>>,
    /// The chain slot `send` observes (a tick that runs late), when set.
    pub send_slot: AtomicU64,
    pub statuses: Mutex<HashMap<Signature, Status>>,
}

impl FakePort {
    pub fn put(&self, k: Address, a: Account) {
        self.accounts.lock().unwrap().insert(k, a);
    }
    pub fn set_clock(&self, slot: u64, now: i64) {
        let mut c = self.clock.lock().unwrap();
        c.slot = slot;
        c.unix_timestamp = now;
    }
    /// `accounts()` calls since the last take.
    pub fn take_calls(&self) -> Vec<Vec<Address>> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
    /// How many times `k` was read since the last take (does not take).
    pub fn reads_of(&self, k: &Address) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.iter().filter(|x| *x == k).count())
            .sum()
    }
}

impl ChainPort for FakePort {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        let mut c = *self.clock.lock().unwrap();
        let s = self.send_slot.load(Ordering::SeqCst);
        if s > 0 {
            c.slot = s;
        }
        Ok(c)
    }
    async fn accounts(&self, keys: &[Address], _: u64) -> PortResult<Vec<Option<Account>>> {
        self.calls.lock().unwrap().push(keys.to_vec());
        let m = self.accounts.lock().unwrap();
        Ok(keys.iter().map(|k| m.get(k).cloned()).collect())
    }
    async fn simulate(&self, _: &[u8]) -> PortResult<SimResult> {
        Ok(SimResult::default())
    }
    async fn send(&self, w: &[u8]) -> PortResult<Signature> {
        let t = tx::from_wire(w).map_err(|e| PortError::Decode(format!("{e:?}")))?;
        let sig = tx::signature(&t);
        self.sent.lock().unwrap().push(t);
        Ok(sig)
    }
    async fn statuses(&self, sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        let m = self.statuses.lock().unwrap();
        Ok(sigs.iter().map(|s| m.get(s).cloned()).collect())
    }
    async fn feed(&self, _: Cursor) -> PortResult<Vec<TxRecord>> {
        Ok(vec![])
    }
    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        Ok((Hash::new_from_array([3; 32]), 150))
    }
}

/// drand's test key, serving a round once `round_time ≤ now`.
#[derive(Clone)]
pub struct FakeDrand {
    pub key: Arc<TestKey>,
    pub now: Arc<AtomicI64>,
}

impl FakeDrand {
    pub fn new() -> FakeDrand {
        FakeDrand {
            key: Arc::new(TestKey::new()),
            now: Arc::new(AtomicI64::new(0)),
        }
    }
}

impl DrandPort for FakeDrand {
    fn round(
        &self,
        r: u64,
    ) -> impl std::future::Future<Output = Result<Option<Beacon>, PortError>> + Send {
        let ok = self.key.info().round_time(r) <= self.now.load(Ordering::SeqCst);
        let b = ok.then(|| self.key.beacon(r));
        async move { Ok(b) }
    }
    fn info(&self) -> ChainInfo {
        self.key.info()
    }
}

pub fn put(d: &mut [u8], o: usize, v: &[u8]) {
    d[o..o + v.len()].copy_from_slice(v);
}

/// An account of `program` with `data`.
pub fn acct(program: Address, data: Vec<u8>) -> Account {
    Account {
        lamports: 1_000_000,
        data,
        owner: program,
        executable: false,
    }
}

/// A Running season: genesis at `genesis_ts`, `end_bell`, the drand clock
/// of `info`, W = 600 s, a 60-s seed margin, a 1,008-bell close grace.
pub fn season(genesis_ts: i64, end_bell: u32, info: &ChainInfo) -> Season {
    let mut d = vec![0u8; size::SEASON];
    put(&mut d, 0, magic::SEASON);
    let mut s = Season::decode(&d).expect("season");
    s.h.season_id = 7;
    s.status = fclient::abi::status::RUNNING;
    s.genesis_ts = genesis_ts;
    s.end_bell = end_bell;
    s.drand_genesis = info.genesis_time;
    s.drand_period = info.period;
    s.reveal_window = 600;
    s.window_next = 600;
    s.window_from_bell = u32::MAX;
    s.seed_margin = 60;
    s.archive_after = 48 * 3_600;
    s.clash_close_grace = 1_008;
    s
}

/// A ClashInputs resolved at `resolved_ts` (seconds after genesis) with no
/// arrival present.
pub fn clash_inputs(resolved_ts: u32) -> Vec<u8> {
    use l::clash_inputs as c;
    let mut d = vec![0u8; size::CLASH_INPUTS];
    put(&mut d, 0, magic::CLASH_INPUTS);
    d[c::FLAGS] = 2 | 1;
    d[c::ARRIVALS_MASK..c::ARRIVALS_MASK + 4].copy_from_slice(&0x00FF_FFFFu32.to_le_bytes());
    put(&mut d, c::RESOLVED_TS, &resolved_ts.to_le_bytes());
    d
}

/// An ArrivalSlot of `host`, settled (`flags & 1`) or not, unclaimed.
pub fn arrival_slot(host: u64, settled: bool) -> Vec<u8> {
    use l::arrival_slot as s;
    let mut d = vec![0u8; size::ARRIVAL_SLOT];
    put(&mut d, 0, magic::ARRIVAL_SLOT);
    put(&mut d, s::HOST_ID, &host.to_le_bytes());
    d[s::FLAGS] = u8::from(settled);
    d
}

/// An ArrivalDay with no bit set.
pub fn arrival_day() -> Vec<u8> {
    let mut d = vec![0u8; size::ARRIVAL_DAY];
    put(&mut d, 0, magic::ARRIVAL_DAY);
    d
}

/// A Province resolved to `resolved_next`, with the sites given as
/// `(tile, state, faction, shield_until_bell)`.
pub fn province(resolved_next: u32, sites: &[(u8, u8, u8, u32)]) -> Vec<u8> {
    use l::province as p;
    use l::site as sm;
    let mut d = vec![0u8; size::PROVINCE];
    put(&mut d, 0, magic::PROVINCE);
    put(&mut d, p::RESOLVED_NEXT, &resolved_next.to_le_bytes());
    d[p::SITE_COUNT] = sites.len() as u8;
    for (k, &(tile, state, faction, shield)) in sites.iter().enumerate() {
        d[p::SITES + k] = tile;
        let o = p::SITE_MIRROR + k * p::SITE_MIRROR_STRIDE;
        d[o + sm::STATE] = state;
        d[o + sm::FACTION] = faction;
        put(&mut d, o + sm::SHIELD_UNTIL_BELL, &shield.to_le_bytes());
    }
    d
}

/// A final Holding of `faction` with one transit in `slot`:
/// `(state, host, depart_bell, arrive_bell, seal_root)`.
pub fn holding(faction: u8, slot: usize, tr: (u8, u64, u32, u32, [u8; 32])) -> Vec<u8> {
    use l::holding as h;
    use l::transit as t;
    let mut d = vec![0u8; size::HOLDING];
    put(&mut d, 0, magic::HOLDING);
    put(&mut d, 8, &7u64.to_le_bytes());
    if let Ok((p, q, site, gen, _)) = fclient::addr::host_parts(tr.1) {
        put(&mut d, h::P, &(p as i16).to_le_bytes());
        put(&mut d, h::Q, &(q as i16).to_le_bytes());
        d[h::SITE] = site;
        d[h::GEN] = gen;
    }
    d[h::STATE] = h::STATE_FINAL;
    d[h::FACTION] = faction;
    let o = h::TRANSIT + slot * h::TRANSIT_STRIDE;
    d[o + t::STATE] = tr.0;
    d[o + t::FACTION] = faction;
    put(&mut d, o + t::HOST_ID, &tr.1.to_le_bytes());
    put(&mut d, o + t::DEPART_BELL, &tr.2.to_le_bytes());
    put(&mut d, o + t::ARRIVE_BELL, &tr.3.to_le_bytes());
    put(&mut d, o + t::SEAL_ROOT, &tr.4);
    d
}

// ------------------------------------------------------------ ABI v2 (CQ2-D)

/// An MC season (ABI v2): [`season`] with `program_version = 2` and the
/// `MC_TEST` conquest block.
pub fn season_v2(genesis_ts: i64, end_bell: u32, info: &ChainInfo) -> Season {
    let mut s = season(genesis_ts, end_bell, info);
    s.program_version = fclient::abi::PROGRAM_VERSION_V2;
    s.conquest = Some(frontier_abi::v2::presets::MC_TEST.cq);
    s
}

/// A v2 Province (4,736 B, `layout_version` 2) at `(p, q)` resolved to
/// `resolved_next`, opened at bell 0, no keep, no sites, no entries.
pub fn province_v2(p: i16, q: i16, resolved_next: u32) -> Vec<u8> {
    use frontier_abi::v2::layout::province::province as p2;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    let mut d = vec![0u8; p2::SIZE];
    assert!(write_header(&mut d, K2::Province, 7));
    put(&mut d, p2::P, &p.to_le_bytes());
    put(&mut d, p2::Q, &q.to_le_bytes());
    put(
        &mut d,
        p2::RING,
        &fclient::ix::ring_of(p as i32, q as i32).to_le_bytes(),
    );
    d[p2::WEDGE] = fclient::ix::wedge_of(p as i32, q as i32);
    d[p2::REGION] = fclient::ix::region_of(p as i32, q as i32);
    put(&mut d, p2::RESOLVED_NEXT, &resolved_next.to_le_bytes());
    frontier_abi::conquest_model::write_no_keep(&mut d).expect("4,736 B");
    d
}

/// Sets `resolved_next` of a v2 (or v1) Province.
pub fn set_resolved_next(d: &mut [u8], rn: u32) {
    put(d, l::province::RESOLVED_NEXT, &rn.to_le_bytes());
}

/// A keep on `tile` held by `holder` (`required` bells to take it).
pub fn set_keep(d: &mut [u8], tile: u8, holder: u8, required: u8) {
    use frontier_abi::v2::kernel::keep::Keep;
    use frontier_abi::v2::layout::province::keep as kp;
    let k = Keep {
        tile,
        holder,
        contender: kp::NONE,
        progress: 0,
        required,
        heartland_safe: false,
        paused: false,
        changes: 0,
        troops: 0,
        since_bell: 0,
        consolidated_until_bell: 0,
        contest_from_bell: 0,
        gen: 0,
        last_taken_from: kp::NONE,
    };
    frontier_abi::conquest_model::write_keep(d, &k).expect("keep");
}

/// A roster entry `i`: host `id` of `faction`, `unit`, on `tile`, with
/// `troops` (MilliTroops), present from bell 0.
pub fn set_entry(d: &mut [u8], i: usize, id: u64, faction: u8, unit: u8, tile: u8, troops: u32) {
    use frontier_abi::layout::province::entry as e;
    use l::province as p;
    let o = p::ENTRIES + i * p::ENTRY_STRIDE;
    put(d, o + e::ID, &id.to_le_bytes());
    d[o + e::FACTION] = faction;
    d[o + e::UNIT] = unit;
    d[o + e::TILE] = tile;
    d[o + e::STATE] = e::STATE_ROSTER;
    put(d, o + e::TROOPS, &troops.to_le_bytes());
    let n = d[p::N_ENTRIES].max(i as u8 + 1);
    d[p::N_ENTRIES] = n;
}

/// Site `i` of a v2 Province: `(tile, state, faction, gen)` (state 1
/// holding, 5 Free City).
pub fn set_site_v2(d: &mut [u8], i: usize, tile: u8, state: u8, faction: u8, gen: u8) {
    use frontier_abi::v2::layout::province::{province as p2, site as s2};
    d[p2::SITES + i] = tile;
    d[p2::SITE_COUNT] = d[p2::SITE_COUNT].max(i as u8 + 1);
    let o = p2::site(i);
    d[o + s2::STATE] = state;
    d[o + s2::FACTION] = faction;
    d[o + s2::GEN] = gen;
}

/// A v2 Holding at `(p, q, site)` of `owner` (Citizen address), generation
/// `gen`, with its rent payer; `capture` = `(prev_owner_tag, prev_gen,
/// prev_home key)` for a captured one.
pub fn holding_v2(
    p: i16,
    q: i16,
    site: u8,
    gen: u8,
    owner: Address,
    rent_payer: Address,
    capture: Option<(u64, u8, u64)>,
) -> Vec<u8> {
    use frontier_abi::v2::layout::player::holding as h2;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    let mut d = vec![0u8; size::HOLDING];
    assert!(write_header(&mut d, K2::Holding, 7));
    put(&mut d, h2::P, &p.to_le_bytes());
    put(&mut d, h2::Q, &q.to_le_bytes());
    d[h2::SITE] = site;
    d[h2::GEN] = gen;
    d[h2::STATE] = h2::STATE_FINAL;
    put(&mut d, h2::OWNER_CITIZEN, owner.as_ref());
    put(&mut d, h2::RENT_PAYER, rent_payer.as_ref());
    if let Some((tag, pg, home)) = capture {
        put(&mut d, h2::PREV_OWNER_TAG, &tag.to_le_bytes());
        d[h2::PREV_GEN] = pg;
        d[h2::CAPTURE_FLAGS] = h2::CAPTURE_FLAG_CAPTURED;
        put(&mut d, h2::PREV_HOME, &home.to_le_bytes());
    }
    d
}

/// A v2 Citizen of `faction` in `shard` with its ticket funder.
pub fn citizen_v2(faction: u8, shard: u8, funder: Address) -> Vec<u8> {
    use frontier_abi::v2::layout::player::citizen as c2;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    let mut d = vec![0u8; size::CITIZEN];
    assert!(write_header(&mut d, K2::Citizen, 7));
    d[c2::FACTION] = faction;
    d[c2::JOIN_SHARD] = shard;
    put(&mut d, c2::TICKET_FUNDER, funder.as_ref());
    d
}

/// A MarchState of `(m, n)` at `next_hour`, rent to `rent_to`.
pub fn march_state(m: i32, n: i32, next_hour: u32, rent_to: Address) -> Vec<u8> {
    use frontier_abi::v2::layout::world::march_state as ms;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};
    let mut d = vec![0u8; size::MARCH_STATE];
    assert!(write_header(&mut d, K2::MarchState, 7));
    put(&mut d, ms::M, &m.to_le_bytes());
    put(&mut d, ms::N, &n.to_le_bytes());
    put(&mut d, ms::NEXT_HOUR, &next_hour.to_le_bytes());
    put(&mut d, ms::RENT_TO, rent_to.as_ref());
    d
}
