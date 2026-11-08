//! **Public march-order material reuse** for the keyless local sandbox
//! (2026-11-08). See `docs/frontier/map-growth/LOCAL-ORDER-MATERIAL-20261108.md`.
//!
//! **Declared, not called.** `main.rs` declares `mod order_material;` so it
//! builds and its tests can run, but nothing here is called by the engine,
//! protocol or browser yet.
//!
//! **What it does.** Packs a valid wide plaintext (`world_index::seal::
//! WidePlain`) for a chosen host, destination, tile and direction list, and
//! rebuilds the 264-byte wide seal exactly as the original exporter's
//! `seal_of` did (`wide_land_runtime_tests.rs:6243-6266`): the **unchanged**
//! published 128-byte IBE header of the public seal vector
//! `valid_spv2_32551361`, the body `body_xor(k, plain)` under that vector's
//! **published** `k`, the commitment under the fixed public `salt_of(k)`,
//! then `ct_hash` and `seal_root`. The golden test reproduces the recorded
//! fixture order (`metadata.tsv` `plain`, `seal`, `commit`, `ct_hash`,
//! `root`, `salt`) byte for byte before anything else is trusted.
//!
//! **What it never does.** No keypair, no key generation or derivation, no
//! signature, no key encapsulation (the IBE header is reused byte for byte,
//! never computed), no network. Every byte of key material is a published
//! fixture constant.
//!
//! **No secrecy.** `k` and the salt are public, so anyone can open every
//! order this module produces. It provides commitment-shaped local test
//! material for arrival bell 20 only, not hidden orders.
//!
//! **Only arrival bell 20.** The reused header is sealed to quicknet round
//! 32,551,361, which is `T(20)` under the fixture Season's genesis and drand
//! clock (checked by [`OrderBinding::new`]). Any other bell is refused.
#![allow(dead_code)] // Declared but not called yet.

use std::collections::BTreeMap;

use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::{rd_arr, rd_u64, rd_u8};
use frontier_abi::ix::HINTS_LEN;
use frontier_abi::layout::header;
use frontier_abi::layout::player::citizen as C;
use frontier_abi::layout::world::season as S;
use frontier_abi::world_index::holding::{self as wh, WideHolding};
use frontier_abi::world_index::seal::{
    self as wseal, WidePlain, WidePlainError, IBE_LEN, WIDE_PLAIN_LEN, WIDE_PLAIN_VERSION,
    WIDE_RESERVED_BYTES, WIDE_SEAL_LEN,
};
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::{ProvinceKey, WideHostRef, WorldId, FIRST_WIDE_RING};
use permutation_frontier::clock::SeasonClock;
use permutation_rules::frontier::seal as ks;
use permutation_rules::frontier::travel::MAX_PATH_STEPS;

// ------------------------------------------------------------ published bytes

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("lowercase hex only"),
    }
}

/// Compile-time hex of exactly `N` bytes (a wrong length fails the build).
const fn hex<const N: usize>(s: &str) -> [u8; N] {
    let b = s.as_bytes();
    assert!(b.len() == 2 * N, "hex length");
    let mut o = [0u8; N];
    let mut i = 0;
    while i < N {
        o[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    o
}

const fn prefix<const N: usize, const M: usize>(s: &[u8; M]) -> [u8; N] {
    assert!(N <= M, "prefix length");
    let mut o = [0u8; N];
    let mut i = 0;
    while i < N {
        o[i] = s[i];
        i += 1;
    }
    o
}

/// The one arrival bell this material supports.
pub const ARRIVE_BELL: u32 = 20;
/// `T(20)` under the fixture Season: the round the header is sealed to.
pub const T_ROUND: u64 = 32_551_361;
/// `S(20, A)` for the fixture anchor time.
pub const S_ROUND: u64 = 32_551_652;
/// The fixture anchor's landing time `A` (213 s into bell 21).
pub const ANCHOR_TS: i64 = 1_790_457_660;

/// The public seal vector whose header and key are reused.
pub const PUBLIC_VECTOR_NAME: &str = "valid_spv2_32551361";
/// `permutation-rules/vectors/seal-vectors-v1.json`, case
/// `valid_spv2_32551361`, field `seal` (the legacy 165-byte seal), verbatim.
pub const PUBLIC_VECTOR_SEAL: [u8; ks::SEAL_LEN] = hex(concat!(
    "919fb5e09d02c53e271bf038b9734b35",
    "a38cbe77865734a6f2a09f0036bfb272",
    "1347223c7305e1c6578dd2e81e90d3bd",
    "1408bf4b64d30b57086f0f0b91dff5d3",
    "5d62db7d30bc9cdf14b98e67f325c8f0",
    "5b40114ba14b7d595849b96ae6d46c5a",
    "d85387effe65f2de3fa8ea30b7293dfd",
    "566a0080f1dd1166fdc9cc4250bdc85c",
    "6f8fdc516c05ad3bec01ff51d7ab3117",
    "4b243ea065c2be83dbce3a16924f43c5",
    "a85e8d4e77",
));
/// Its first 128 bytes, `U ‖ V ‖ W`, reused unchanged in every wide seal
/// (the exporter's `ibe = legacy[..IBE_LEN]`, `:6094`).
pub const PUBLIC_IBE_HEADER: [u8; IBE_LEN] = prefix(&PUBLIC_VECTOR_SEAL);
/// The same case's published `k` (also `stock_k`): the key the header
/// encapsulates for round 32,551,361. Public; no secrecy.
pub const PUBLIC_K: [u8; ks::K_LEN] = hex("e83b044517da35e737ff3d59d4f54921");
/// `salt_of(PUBLIC_K)`, the case's `salt` and `metadata.tsv` `salt`.
pub const PUBLIC_SALT: [u8; 32] =
    hex("5e2e21d1b27a88997364fe716a94056fc24f072800ad8ee9ec3f8fc9d7597b5b");
/// The public quicknet signature of `T_ROUND` (vector `open_sig`,
/// `frontier-node/crates/fclient/fixtures/quicknet/32551361.json`).
pub const PUBLIC_SIG_T: [u8; 48] = hex(concat!(
    "b07de38f2242ea4ae09960f14c44b826764b4f00a7b5dbb6",
    "4f0adaeb8084fd91231934b3f7e1e2ae86cadd2d27a5272f",
));
/// The public quicknet signature of `S_ROUND`
/// (`frontier-node/crates/fclient/fixtures/quicknet/32551652.json`).
pub const PUBLIC_SIG_S: [u8; 48] = hex(concat!(
    "947a98f470bab0f331afab6c751a0dac02abf65b3f3e9aff",
    "8fd859cb611f32fd4a3b9a9e7018ce2996a23f13ec9bc345",
));

/// Labels the UI should show beside any order built here.
pub const ORDER_EVIDENCE_LABELS: [(&str, &str); 6] = [
    (
        "seal",
        "PUBLIC_SEAL_MATERIAL_NO_SECRECY: published k and salt; anyone can open the order",
    ),
    (
        "ibe_header",
        "REUSED_PUBLIC_IBE_HEADER_T20: vector valid_spv2_32551361's 128 bytes, unchanged",
    ),
    (
        "beacon",
        "PUBLIC_BEACON_SIGNATURES_T20_S20: published quicknet rounds 32551361 and 32551652",
    ),
    (
        "arrival_bell",
        "ARRIVAL_BELL_20_ONLY: no other bell has a published header",
    ),
    ("auth", "NO_KEY_NO_SIGNATURE_NO_ENCAPSULATION"),
    (
        "route",
        "PLAINTEXT_VALIDATED_ROUTE_NOT_WALKED: terrain, provinces entered and travel time are \
         judged only by the real Reveal",
    ),
];

// ------------------------------------------------------------ types

/// Why an order or a binding is refused. Every refusal happens before any
/// output exists; inputs are only borrowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderError {
    SeasonKind,
    /// The Season key is not the PDA of its stored id and bump.
    SeasonAddress,
    SeasonClock,
    /// `T(20)`, `S(20, A)` or `A ≥ round_time(T)` disagrees with the pins
    /// under this Season's clock.
    RoundMismatch,
    CitizenKind,
    HoldingRecord,
    /// The holding is not the host's (coordinate, site, generation,
    /// canonical address).
    HoldingMismatch,
    /// The holding's owner is not the given Citizen.
    OwnerMismatch,
    /// The host's world is not the Season's.
    HostWorld,
    UnsupportedArrivalBell(u32),
    EmptyPath,
    TooManyDirections(usize),
    BadDirection {
        index: usize,
        dir: u8,
    },
    DestinationWorld,
    /// The destination is inside the legacy disk.
    NotWideDestination,
    /// The deployed wide plaintext validation (`world_index::seal::validate`).
    Plain(WidePlainError),
    SaltMismatch,
    /// The rebuilt seal does not open to its own plaintext.
    SelfCheck,
    BeaconMeta(&'static str),
    BeaconPin(&'static str),
}

/// An account snapshot as the sandbox holds it.
#[derive(Clone, Copy, Debug)]
pub struct Snapshot<'a> {
    pub key: [u8; 32],
    pub owner: [u8; 32],
    pub data: &'a [u8],
}

/// Who departs, in which Season and world: checked once, then reused for
/// every order. The checks are canonical-address and record consistency
/// over supplied snapshot bytes, not authentication of those bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderBinding {
    pub program: [u8; 32],
    pub season_key: [u8; 32],
    pub season_id: u64,
    pub world: WorldId,
    pub genesis_ts: i64,
    pub citizen: [u8; 32],
    pub host: WideHostRef,
}

/// What the order says (the plaintext's free fields).
#[derive(Clone, Copy, Debug)]
pub struct OrderRequest<'a> {
    pub dest: ProvinceKey,
    pub dest_tile: u8,
    pub directions: &'a [u8],
    pub stance: u8,
    pub retreat_bps: u16,
    pub arrive_bell: u32,
}

/// One order's Depart and Reveal material.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderMaterial {
    pub host: WideHostRef,
    pub dest: ProvinceKey,
    pub arrive_bell: u32,
    pub plain: [u8; WIDE_PLAIN_LEN],
    pub seal: [u8; WIDE_SEAL_LEN],
    pub salt: [u8; 32],
    pub commit: [u8; 32],
    pub ct_hash: [u8; 32],
    pub root: [u8; 32],
}

/// The public beacon material of arrival bell 20, from `metadata.tsv`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArrivalBeacon {
    pub arrive_bell: u32,
    pub anchor_ts: i64,
    pub t_round: u64,
    pub sig_t: [u8; 48],
    pub hints_t: [u8; HINTS_LEN],
    pub s_round: u64,
    pub sig_s: [u8; 48],
    pub hints_s: [u8; HINTS_LEN],
}

// ------------------------------------------------------------ binding

impl OrderBinding {
    /// Binds a host to its Season, world, holding and owner Citizen:
    ///
    /// - Season: owned by `program`, Season magic, key equal to
    ///   `season_pda(id, bump, program)`, world `derive_legacy_season`; its
    ///   clock gives `T(20) = T_ROUND`, `S(20, ANCHOR_TS) = S_ROUND` and
    ///   `ANCHOR_TS ≥ round_time(T_ROUND)`.
    /// - Citizen: owned by `program`, Citizen magic, this Season's id.
    /// - Holding: `WideHolding::read`, this Season and world, at
    ///   `holding_address(coord, site)`, the host's coordinate, site and
    ///   generation, owned by the Citizen.
    /// - Host: in the Season's world.
    pub fn new(
        program: &[u8; 32],
        season: Snapshot<'_>,
        citizen: Snapshot<'_>,
        holding: Snapshot<'_>,
        host: WideHostRef,
    ) -> Result<OrderBinding, OrderError> {
        let sd = season.data;
        if season.owner != *program || rd_arr::<8>(sd, header::MAGIC) != Some(S::MAGIC) {
            return Err(OrderError::SeasonKind);
        }
        let season_id = rd_u64(sd, header::SEASON_ID).ok_or(OrderError::SeasonKind)?;
        let bump = rd_u8(sd, S::BUMP).ok_or(OrderError::SeasonKind)?;
        if permutation_frontier::addr::season_pda(season_id, bump, program) != season.key {
            return Err(OrderError::SeasonAddress);
        }
        let world = WorldId::derive_legacy_season(&season.key, program)
            .map_err(|_| OrderError::SeasonKind)?;
        let clock = SeasonClock::read(sd).map_err(|_| OrderError::SeasonClock)?;
        if clock.tlock_round(ARRIVE_BELL) != T_ROUND
            || clock.seed_round(ARRIVE_BELL, ANCHOR_TS) != S_ROUND
            || ANCHOR_TS < clock.round_time(T_ROUND)
        {
            return Err(OrderError::RoundMismatch);
        }
        if citizen.owner != *program
            || rd_arr::<8>(citizen.data, header::MAGIC) != Some(C::MAGIC)
            || rd_u64(citizen.data, header::SEASON_ID) != Some(season_id)
        {
            return Err(OrderError::CitizenKind);
        }
        if host.key().world() != world {
            return Err(OrderError::HostWorld);
        }
        let h = WideHolding::read(holding.data).map_err(|_| OrderError::HoldingRecord)?;
        if holding.owner != *program || h.season_id != season_id || h.world != world {
            return Err(OrderError::HoldingRecord);
        }
        let ctx = AddrCtx {
            season: season.key,
            program: *program,
        };
        if h.coord != host.key().coord()
            || h.site != host.site()
            || h.gen != host.gen()
            || holding.key != wh::holding_address(&ctx, h.coord, h.site)
        {
            return Err(OrderError::HoldingMismatch);
        }
        if h.owner_citizen != citizen.key {
            return Err(OrderError::OwnerMismatch);
        }
        Ok(OrderBinding {
            program: *program,
            season_key: season.key,
            season_id,
            world,
            genesis_ts: clock.genesis_ts,
            citizen: citizen.key,
            host,
        })
    }
}

// ------------------------------------------------------------ orders

/// The deployed plaintext of one order, validated (no seal yet).
pub fn order_plain(b: &OrderBinding, r: &OrderRequest<'_>) -> Result<WidePlain, OrderError> {
    if r.arrive_bell != ARRIVE_BELL {
        return Err(OrderError::UnsupportedArrivalBell(r.arrive_bell));
    }
    if r.directions.is_empty() {
        return Err(OrderError::EmptyPath);
    }
    if r.directions.len() > MAX_PATH_STEPS {
        return Err(OrderError::TooManyDirections(r.directions.len()));
    }
    if let Some((index, &dir)) = r.directions.iter().enumerate().find(|(_, d)| **d >= 6) {
        return Err(OrderError::BadDirection { index, dir });
    }
    if r.dest.world() != b.world {
        return Err(OrderError::DestinationWorld);
    }
    if r.dest.coord().ring() < FIRST_WIDE_RING {
        return Err(OrderError::NotWideDestination);
    }
    let (path_len, path) =
        ks::encode_path(r.directions).ok_or(OrderError::TooManyDirections(r.directions.len()))?;
    let plain = WidePlain {
        version: WIDE_PLAIN_VERSION,
        host: b.host,
        arrive_bell: ARRIVE_BELL,
        dest: r.dest,
        dest_tile: r.dest_tile,
        stance: r.stance,
        retreat_bps: r.retreat_bps,
        path_len,
        path,
        reserved: [0; WIDE_RESERVED_BYTES],
    };
    wseal::validate(&plain, &b.host, ARRIVE_BELL).map_err(OrderError::Plain)?;
    Ok(plain)
}

/// Seals a validated plaintext with the reused public material, the
/// original `seal_of` step for step: `pack`, `assemble(header,
/// body_xor(k, pt))`, `commit(pt, salt_of(k))`, `ct_hash`, `seal_root`;
/// then requires the seal to open to its own plaintext.
fn seal_plain(plain: &WidePlain) -> Result<OrderMaterial, OrderError> {
    let pt = wseal::pack(plain);
    let salt = ks::salt_of(&PUBLIC_K);
    if salt != PUBLIC_SALT {
        return Err(OrderError::SaltMismatch);
    }
    let seal = wseal::assemble(&PUBLIC_IBE_HEADER, &wseal::body_xor(&PUBLIC_K, &pt));
    let commit = wseal::commit(&pt, &salt);
    let ct_hash = wseal::ct_hash(&seal);
    let root = wseal::seal_root(&commit, &ct_hash);
    if wseal::open_body(&PUBLIC_K, &seal, &commit) != Some(pt)
        || wseal::unpack(&pt).ok() != Some(*plain)
    {
        return Err(OrderError::SelfCheck);
    }
    Ok(OrderMaterial {
        host: plain.host,
        dest: plain.dest,
        arrive_bell: plain.arrive_bell,
        plain: pt,
        seal,
        salt,
        commit,
        ct_hash,
        root,
    })
}

/// One order's material. Pure: inputs are borrowed, and a refusal returns
/// before any output exists.
pub fn build_order(b: &OrderBinding, r: &OrderRequest<'_>) -> Result<OrderMaterial, OrderError> {
    seal_plain(&order_plain(b, r)?)
}

/// Replaces `current` only on success; a refusal leaves it untouched.
pub fn replace_order(
    current: &mut OrderMaterial,
    b: &OrderBinding,
    r: &OrderRequest<'_>,
) -> Result<(), OrderError> {
    let next = build_order(b, r)?;
    *current = next;
    Ok(())
}

impl OrderMaterial {
    /// The WideDepart data of this order (`wide_ix::Depart`).
    pub fn depart(&self, transit_slot: u8, tip: u64) -> wix::Depart {
        wix::Depart {
            host: self.host.to_bytes(),
            transit_slot,
            arrive_bell: self.arrive_bell,
            tip,
            commit: self.commit,
            seal: self.seal,
        }
    }

    /// What a Reveal carries besides its accounts: `(plain, salt, ct_hash)`.
    pub fn reveal_fields(&self) -> ([u8; WIDE_PLAIN_LEN], [u8; 32], [u8; 32]) {
        (self.plain, self.salt, self.ct_hash)
    }
}

// ------------------------------------------------------------ beacon

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect()
}

fn meta_bytes<const N: usize>(
    meta: &BTreeMap<String, String>,
    k: &'static str,
) -> Result<[u8; N], OrderError> {
    meta.get(k)
        .and_then(|v| unhex(v.as_str()))
        .and_then(|v| <[u8; N]>::try_from(v).ok())
        .ok_or(OrderError::BeaconMeta(k))
}

fn meta_num<T: std::str::FromStr>(
    meta: &BTreeMap<String, String>,
    k: &'static str,
) -> Result<T, OrderError> {
    meta.get(k)
        .and_then(|v| v.parse::<T>().ok())
        .ok_or(OrderError::BeaconMeta(k))
}

/// The public beacon material of bell 20 from `metadata.tsv`, pinned:
/// the bell, both rounds, the anchor time and both signatures must be the
/// published ones; the hints must have their exact length (they are
/// verification material only, checked by the real PostAnchor/PostSeed).
/// The rounds depend on the bell and `A`, not on a region, so the same
/// material serves THE anchor of any destination region at bell 20.
pub fn arrival_beacon(meta: &BTreeMap<String, String>) -> Result<ArrivalBeacon, OrderError> {
    let beacon = ArrivalBeacon {
        arrive_bell: meta_num(meta, "arrive_bell")?,
        anchor_ts: meta_num(meta, "anchor_ts")?,
        t_round: meta_num(meta, "t_round")?,
        sig_t: meta_bytes(meta, "sig_t")?,
        hints_t: meta_bytes(meta, "hints_t")?,
        s_round: meta_num(meta, "s_round")?,
        sig_s: meta_bytes(meta, "sig_s")?,
        hints_s: meta_bytes(meta, "hints_s")?,
    };
    let pins = [
        ("arrive_bell", beacon.arrive_bell == ARRIVE_BELL),
        ("anchor_ts", beacon.anchor_ts == ANCHOR_TS),
        ("t_round", beacon.t_round == T_ROUND),
        ("sig_t", beacon.sig_t == PUBLIC_SIG_T),
        ("s_round", beacon.s_round == S_ROUND),
        ("sig_s", beacon.sig_s == PUBLIC_SIG_S),
    ];
    if let Some((k, _)) = pins.iter().find(|(_, ok)| !*ok) {
        return Err(OrderError::BeaconPin(k));
    }
    Ok(beacon)
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::log::seal_code;
    use frontier_abi::world_index::WideCoord;
    use permutation_frontier::crypto::{quick, seal as cseal};

    struct Fixture {
        images: BTreeMap<String, ([u8; 32], [u8; 32], Vec<u8>)>,
        meta: BTreeMap<String, String>,
    }

    /// The committed fixtures, parsed here (no engine, exporter or signing
    /// code is called).
    fn fixture() -> Fixture {
        let mut images = BTreeMap::new();
        for line in include_str!("fixtures/accounts.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let f: Vec<&str> = line.split('\t').collect();
            assert_eq!(f.len(), 5, "accounts.tsv columns");
            let key: [u8; 32] = unhex(f[1]).unwrap().try_into().unwrap();
            let owner: [u8; 32] = unhex(f[2]).unwrap().try_into().unwrap();
            images.insert(f[0].to_string(), (key, owner, unhex(f[4]).unwrap()));
        }
        let mut meta = BTreeMap::new();
        for line in include_str!("fixtures/metadata.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (k, v) = line.split_once('\t').unwrap();
            meta.insert(k.to_string(), v.to_string());
        }
        Fixture { images, meta }
    }

    impl Fixture {
        fn snap(&self, name: &str) -> Snapshot<'_> {
            let (key, owner, data) = &self.images[name];
            Snapshot {
                key: *key,
                owner: *owner,
                data,
            }
        }
        fn program(&self) -> [u8; 32] {
            unhex(&self.meta["program"]).unwrap().try_into().unwrap()
        }
        fn host(&self) -> WideHostRef {
            WideHostRef::from_bytes(&unhex(&self.meta["host"]).unwrap()).unwrap()
        }
        fn world(&self) -> WorldId {
            WorldId::new(unhex(&self.meta["world"]).unwrap().try_into().unwrap()).unwrap()
        }
        fn bytes(&self, k: &str) -> Vec<u8> {
            unhex(&self.meta[k]).unwrap()
        }
        fn binding(&self) -> OrderBinding {
            self.bind(self.host()).expect("binding")
        }
        fn bind(&self, host: WideHostRef) -> Result<OrderBinding, OrderError> {
            OrderBinding::new(
                &self.program(),
                self.snap("season"),
                self.snap("citizen"),
                self.snap("holding"),
                host,
            )
        }
        fn key(&self, p: i64, q: i64) -> ProvinceKey {
            ProvinceKey::new(self.world(), WideCoord::checked(p, q).unwrap())
        }
    }

    /// One case of `seal-vectors-v1.json` (pretty-printed, one field per
    /// line), field by field.
    fn vector_field(name: &str, field: &str) -> String {
        let text = include_str!("../../../permutation-rules/vectors/seal-vectors-v1.json");
        let mut cur: Vec<(String, String)> = Vec::new();
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with('{') {
                cur.clear();
                continue;
            }
            if t.starts_with('}') {
                if cur.iter().any(|(k, v)| k == "name" && v == name) {
                    return cur
                        .iter()
                        .find(|(k, _)| k == field)
                        .map(|(_, v)| v.clone())
                        .expect("field");
                }
                cur.clear();
                continue;
            }
            if let Some((k, v)) = t.split_once(": ") {
                let k = k.trim_matches('"').to_string();
                let v = v.trim_end_matches(',').trim_matches('"').to_string();
                cur.push((k, v));
            }
        }
        panic!("vector {name} not found");
    }

    fn fclient_signature(json: &str) -> Vec<u8> {
        let (_, rest) = json.split_once("\"signature\":\"").expect("signature");
        let (sig, _) = rest.split_once('"').expect("end");
        unhex(sig).unwrap()
    }

    fn recorded_request(fx: &Fixture) -> (ProvinceKey, u8, Vec<u8>) {
        let p: i64 = fx.meta["destination_p"].parse().unwrap();
        let q: i64 = fx.meta["destination_q"].parse().unwrap();
        let tile: u8 = fx.meta["destination_tile"].parse().unwrap();
        (fx.key(p, q), tile, fx.bytes("directions"))
    }

    fn request<'a>(dest: ProvinceKey, dest_tile: u8, directions: &'a [u8]) -> OrderRequest<'a> {
        OrderRequest {
            dest,
            dest_tile,
            directions,
            stance: 0,
            retreat_bps: 0,
            arrive_bell: ARRIVE_BELL,
        }
    }

    #[test]
    fn order_material_golden_reproduces_recorded_fixture_order_byte_for_byte() {
        let fx = fixture();
        let b = fx.binding();
        let (dest, tile, dirs) = recorded_request(&fx);
        assert_eq!(dirs, [2, 2, 2]);
        // The exporter's seal_of: stance 0, retreat 0 (`:6251-6252`).
        let m = build_order(&b, &request(dest, tile, &dirs)).expect("golden order");
        assert_eq!(m.plain.to_vec(), fx.bytes("plain"), "plain");
        assert_eq!(m.seal.to_vec(), fx.bytes("seal"), "seal");
        assert_eq!(m.salt.to_vec(), fx.bytes("salt"), "salt");
        assert_eq!(m.commit.to_vec(), fx.bytes("commit"), "commit");
        assert_eq!(m.ct_hash.to_vec(), fx.bytes("ct_hash"), "ct_hash");
        assert_eq!(m.root.to_vec(), fx.bytes("root"), "root");
        assert_eq!(m.host.to_bytes().to_vec(), fx.bytes("host"), "host");
        let d = m.depart(0, fx.meta["tip"].parse().unwrap());
        assert_eq!((d.arrive_bell, d.commit, d.seal), (20, m.commit, m.seal));
    }

    #[test]
    fn order_material_public_constants_match_published_vectors() {
        let fx = fixture();
        let v = |f: &str| vector_field(PUBLIC_VECTOR_NAME, f);
        assert_eq!(PUBLIC_VECTOR_SEAL.to_vec(), unhex(&v("seal")).unwrap());
        assert_eq!(PUBLIC_IBE_HEADER[..], PUBLIC_VECTOR_SEAL[..IBE_LEN]);
        assert_eq!(PUBLIC_IBE_HEADER[..], fx.bytes("seal")[..IBE_LEN]);
        assert_eq!(PUBLIC_K.to_vec(), unhex(&v("k")).unwrap());
        assert_eq!(PUBLIC_K.to_vec(), unhex(&v("stock_k")).unwrap());
        assert_eq!(ks::salt_of(&PUBLIC_K), PUBLIC_SALT);
        assert_eq!(PUBLIC_SALT.to_vec(), unhex(&v("salt")).unwrap());
        assert_eq!(PUBLIC_SALT.to_vec(), fx.bytes("salt"));
        assert_eq!(v("round"), T_ROUND.to_string());
        assert_eq!(PUBLIC_SIG_T.to_vec(), unhex(&v("open_sig")).unwrap());
        assert_eq!(
            PUBLIC_SIG_T.to_vec(),
            fclient_signature(include_str!(
                "../../../frontier-node/crates/fclient/fixtures/quicknet/32551361.json"
            ))
        );
        assert_eq!(
            PUBLIC_SIG_S.to_vec(),
            fclient_signature(include_str!(
                "../../../frontier-node/crates/fclient/fixtures/quicknet/32551652.json"
            ))
        );
        assert_eq!(PUBLIC_SIG_T.to_vec(), fx.bytes("sig_t"));
        assert_eq!(PUBLIC_SIG_S.to_vec(), fx.bytes("sig_s"));
        assert!(ORDER_EVIDENCE_LABELS
            .iter()
            .all(|(k, l)| !k.is_empty() && !l.is_empty()));
    }

    #[test]
    fn order_material_new_destination_reuses_header_and_changes_only_body() {
        let fx = fixture();
        let b = fx.binding();
        let (dest, tile, dirs) = recorded_request(&fx);
        let golden = build_order(&b, &request(dest, tile, &dirs)).unwrap();
        let other = fx.key(129, -2);
        let route = [2u8, 2, 2, 3];
        let m = build_order(&b, &request(other, 10, &route)).expect("new destination");
        assert_eq!(
            m.seal[..IBE_LEN],
            PUBLIC_IBE_HEADER[..],
            "header reused unchanged"
        );
        assert_eq!(m.salt, golden.salt, "the one public salt");
        assert_ne!(m.plain, golden.plain);
        assert_ne!(m.seal[IBE_LEN..], golden.seal[IBE_LEN..]);
        assert_ne!(m.commit, golden.commit);
        assert_ne!(m.root, golden.root);
        let p = wseal::unpack(&m.plain).unwrap();
        assert_eq!((p.dest, p.dest_tile, p.path_len), (other, 10, 4));
        assert_eq!(p.host, fx.host());
        assert_eq!(wseal::validate(&p, &fx.host(), 20), Ok(()));
        // No secrecy: the published key opens it.
        assert_eq!(
            wseal::open_body(&PUBLIC_K, &m.seal, &m.commit),
            Some(m.plain)
        );
        // Deterministic.
        assert_eq!(build_order(&b, &request(other, 10, &route)).unwrap(), m);
        assert_eq!(
            wseal::seal_root(&m.commit, &wseal::ct_hash(&m.seal)),
            m.root
        );
    }

    #[test]
    fn order_material_rejects_unsupported_arrival_bell_without_mutation() {
        let fx = fixture();
        let b = fx.binding();
        let (dest, tile, dirs) = recorded_request(&fx);
        let mut current = build_order(&b, &request(dest, tile, &dirs)).unwrap();
        let snap = current;
        for bell in [0u32, 19, 21, 22, 72, u32::MAX] {
            let mut r = request(dest, tile, &dirs);
            r.arrive_bell = bell;
            assert_eq!(
                replace_order(&mut current, &b, &r),
                Err(OrderError::UnsupportedArrivalBell(bell))
            );
            assert_eq!(current, snap);
        }
    }

    #[test]
    fn order_material_rejects_bad_or_excessive_directions_without_mutation() {
        let fx = fixture();
        let b = fx.binding();
        let (dest, tile, dirs) = recorded_request(&fx);
        let mut current = build_order(&b, &request(dest, tile, &dirs)).unwrap();
        let snap = current;
        let too_many = [0u8; 33];
        let cases: [(&[u8], OrderError); 5] = [
            (&[], OrderError::EmptyPath),
            (&too_many, OrderError::TooManyDirections(33)),
            (&[2, 6], OrderError::BadDirection { index: 1, dir: 6 }),
            (&[7], OrderError::BadDirection { index: 0, dir: 7 }),
            (
                &[0, 1, 255],
                OrderError::BadDirection { index: 2, dir: 255 },
            ),
        ];
        for (route, want) in cases {
            assert_eq!(
                replace_order(&mut current, &b, &request(dest, tile, route)),
                Err(want)
            );
            assert_eq!(current, snap);
        }
        // The bound itself is accepted: 32 steps, every direction.
        let longest: Vec<u8> = (0..32u8).map(|i| i % 6).collect();
        let m = build_order(&b, &request(dest, tile, &longest)).expect("32 steps");
        assert_eq!(wseal::unpack(&m.plain).unwrap().path_len, 32);
        for (i, d) in longest.iter().enumerate() {
            assert_eq!(ks::path_step(&wseal::unpack(&m.plain).unwrap().path, i), *d);
        }
    }

    #[test]
    fn order_material_rejects_bad_destination_shape_without_mutation() {
        let fx = fixture();
        let b = fx.binding();
        let (dest, tile, dirs) = recorded_request(&fx);
        let mut current = build_order(&b, &request(dest, tile, &dirs)).unwrap();
        let snap = current;
        let foreign = ProvinceKey::new(
            WorldId::new([0x78; 32]).unwrap(),
            WideCoord::checked(129, -1).unwrap(),
        );
        let mut stance = request(dest, tile, &dirs);
        stance.stance = 4;
        let mut retreat = request(dest, tile, &dirs);
        retreat.retreat_bps = 60_001;
        let cases = [
            (request(foreign, tile, &dirs), OrderError::DestinationWorld),
            (
                request(fx.key(128, 0), tile, &dirs),
                OrderError::NotWideDestination,
            ),
            (
                request(fx.key(0, 0), tile, &dirs),
                OrderError::NotWideDestination,
            ),
            (
                request(dest, 61, &dirs),
                OrderError::Plain(WidePlainError::Tile),
            ),
            (stance, OrderError::Plain(WidePlainError::Stance)),
            (retreat, OrderError::Plain(WidePlainError::Retreat)),
        ];
        for (r, want) in cases {
            assert_eq!(replace_order(&mut current, &b, &r), Err(want));
            assert_eq!(current, snap);
        }
    }

    #[test]
    fn order_material_binding_rejects_mismatched_host_citizen_season() {
        let fx = fixture();
        let host = fx.host();
        let program = fx.program();
        assert!(fx.bind(host).is_ok());
        // Another site, generation or province of the same world.
        let k = host.key();
        for h in [
            WideHostRef::new(k, host.site() + 1, host.gen(), host.seq()).unwrap(),
            WideHostRef::new(k, host.site(), host.gen() + 1, host.seq()).unwrap(),
            WideHostRef::new(fx.key(129, -1), host.site(), host.gen(), host.seq()).unwrap(),
        ] {
            assert_eq!(fx.bind(h), Err(OrderError::HoldingMismatch));
        }
        // A host of another world.
        let foreign = ProvinceKey::new(WorldId::new([0x78; 32]).unwrap(), k.coord());
        let h = WideHostRef::new(foreign, host.site(), host.gen(), host.seq()).unwrap();
        assert_eq!(fx.bind(h), Err(OrderError::HostWorld));
        // Another Citizen (the payer's key), and a non-Citizen record.
        let mut citizen = fx.snap("citizen");
        citizen.key = [0xd4; 32];
        let r = OrderBinding::new(
            &program,
            fx.snap("season"),
            citizen,
            fx.snap("holding"),
            host,
        );
        assert_eq!(r, Err(OrderError::OwnerMismatch));
        let r = OrderBinding::new(
            &program,
            fx.snap("season"),
            fx.snap("holding"),
            fx.snap("holding"),
            host,
        );
        assert_eq!(r, Err(OrderError::CitizenKind));
        // A Season at another key, under another program, with another genesis.
        let mut season = fx.snap("season");
        season.key[0] ^= 1;
        let r = OrderBinding::new(
            &program,
            season,
            fx.snap("citizen"),
            fx.snap("holding"),
            host,
        );
        assert_eq!(r, Err(OrderError::SeasonAddress));
        let r = OrderBinding::new(
            &[0x13; 32],
            fx.snap("season"),
            fx.snap("citizen"),
            fx.snap("holding"),
            host,
        );
        assert_eq!(r, Err(OrderError::SeasonKind));
        let mut sd = fx.images["season"].2.clone();
        let g = S::GENESIS_TS;
        sd[g] = sd[g].wrapping_add(1);
        let season = Snapshot {
            data: &sd,
            ..fx.snap("season")
        };
        let r = OrderBinding::new(
            &program,
            season,
            fx.snap("citizen"),
            fx.snap("holding"),
            host,
        );
        assert_eq!(r, Err(OrderError::RoundMismatch));
        // A holding at a non-canonical key.
        let mut holding = fx.snap("holding");
        holding.key[0] ^= 1;
        let r = OrderBinding::new(
            &program,
            fx.snap("season"),
            fx.snap("citizen"),
            holding,
            host,
        );
        assert_eq!(r, Err(OrderError::HoldingMismatch));
    }

    #[test]
    fn order_material_arrival_beacon_pins_public_metadata() {
        let fx = fixture();
        let beacon = arrival_beacon(&fx.meta).expect("beacon");
        assert_eq!(
            (
                beacon.arrive_bell,
                beacon.t_round,
                beacon.s_round,
                beacon.anchor_ts
            ),
            (ARRIVE_BELL, T_ROUND, S_ROUND, ANCHOR_TS)
        );
        let zeros = "00".repeat(48);
        let cases: [(&str, &str, OrderError); 5] = [
            ("t_round", "32551362", OrderError::BeaconPin("t_round")),
            ("arrive_bell", "21", OrderError::BeaconPin("arrive_bell")),
            (
                "anchor_ts",
                "1790457661",
                OrderError::BeaconPin("anchor_ts"),
            ),
            ("sig_s", zeros.as_str(), OrderError::BeaconPin("sig_s")),
            ("hints_t", "00", OrderError::BeaconMeta("hints_t")),
        ];
        for (k, v, want) in cases {
            let mut meta = fx.meta.clone();
            meta.insert(k.to_string(), v.to_string());
            assert_eq!(arrival_beacon(&meta), Err(want), "{k}");
        }
        let mut meta = fx.meta.clone();
        meta.remove("sig_t");
        assert_eq!(arrival_beacon(&meta), Err(OrderError::BeaconMeta("sig_t")));
    }

    /// Native BLS (the `local-march-demo` build's real SIMD-0388 math):
    /// the public signatures verify against the production quicknet key at
    /// their rounds; the reused header recovers the published `k` under
    /// round T(20) through the real pairing and Fujisaki–Okamoto check; and
    /// a rebuilt order to a new destination is judged VALID by the
    /// deployed wide opener. Verification only: nothing is signed.
    #[test]
    fn order_material_native_opener_recovers_public_k_and_judges_new_order_valid() {
        let fx = fixture();
        let beacon = arrival_beacon(&fx.meta).unwrap();
        let sig96 = quick::verify(T_ROUND, &beacon.sig_t, &beacon.hints_t).expect("T(20)");
        assert!(
            quick::verify(S_ROUND, &beacon.sig_s, &beacon.hints_s).is_ok(),
            "S(20, A)"
        );
        assert!(quick::verify(S_ROUND, &beacon.sig_t, &beacon.hints_s).is_err());
        assert_eq!(cseal::recover_key(&sig96, &PUBLIC_IBE_HEADER), Ok(PUBLIC_K));
        let b = fx.binding();
        let (dest, tile, dirs) = recorded_request(&fx);
        let golden = build_order(&b, &request(dest, tile, &dirs)).unwrap();
        let route = [2u8, 2, 2, 3];
        let m = build_order(&b, &request(fx.key(129, -2), 10, &route)).unwrap();
        for order in [golden, m] {
            let plain = wseal::unpack(&order.plain).unwrap();
            assert_eq!(
                cseal::judge_wide(&sig96, &order.seal, &order.commit, &b.host, ARRIVE_BELL),
                (seal_code::VALID, Some(plain))
            );
        }
        // Tampering is caught by the deployed opener, not by this module.
        let mut body = m.seal;
        body[IBE_LEN] ^= 1;
        assert_eq!(
            cseal::open_wide(&sig96, &body, &m.commit),
            Err(seal_code::COMMIT_MISMATCH)
        );
        let other = WideHostRef::new(b.host.key(), b.host.site(), b.host.gen(), 1).unwrap();
        assert_eq!(
            cseal::judge_wide(&sig96, &m.seal, &m.commit, &other, ARRIVE_BELL),
            (seal_code::BAD_PLAINTEXT, None)
        );
        assert_eq!(
            cseal::judge_wide(&sig96, &m.seal, &m.commit, &b.host, ARRIVE_BELL + 1),
            (seal_code::BAD_PLAINTEXT, None)
        );
    }
}
