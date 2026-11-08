//! An S1 (layout 2) map-growth archive (⑲, 2026-11-08): ring 4 → ring 5
//! with ExtendFrontier, to workstream 8's contract
//! (`permutation-gateway/test/fixtures/frontier/growth-route.mjs`, branch
//! `claude/festive-tesla-iwwc5t` 5e7ac44c), for the router golden
//! `tests/golden/ws19-map-growth-s1.json` (`tests/ws19_map_contract.rs`).
//!
//! Season 71: program_version 4, the S1 ruleset (`RULESET_HASH_V3`),
//! `MC_LOCAL_7D`'s conquest block with `r_max_ceiling` 6, placement 0,
//! not continuous; genesis ring 3, Season `r_max` 4, genesis seed `[1; 32]`.
//! Ring seeds are `sha256("ring" ‖ d)` (8's rule) for every ring. On a
//! real chain rings `0..=genesis_ring` are seeded at open from
//! `sha256("PSF-RING" ‖ genesis_seed ‖ le16 d)` instead; the herald does not
//! check the rule, so this fixture follows 8 for all rings (noted, not a
//! rule change). Province terrain, sites and passable mask come from
//! `generate_province(ring seed, coordinate)`.
//!
//! Stages:
//! - **before**: rings 0–4 seeded, all 61 Provinces on chain; Frontier
//!   `rings_opened` 5, `r_max_ext` 0. The fixture wallet's Citizen, its
//!   Holding at [`HOME`] site 0, and its host on (4, 0) tile 0.
//! - **extended**: ExtendFrontier(5): FRONTIER_EXTENDED (104), `r_max_ext` 5.
//! - **opened**: OpenRing(5): RING_OPEN without a seed, RingSeed requested,
//!   `rings_opened` 6.
//! - **grown**: ConsumeRingSeed(5): RING_SEED with the seed, and the 30
//!   Provinces of ring 5.
//!
//! Keyless: fixed byte-pattern signatures, no transaction bytes, public
//! PDAs.

use sha2::{Digest, Sha256};
use solana_address::Address;

use fclient::log::log_line;
use fclient::ports::{Account, Signature, TxRecord};
use frontier_abi::addr::{host_id, AddrCtx};
use frontier_abi::clash_model::{self as cm, TERRAINS};
use frontier_abi::conquest_model as qm;
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::province::entry as E;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::log::Kind as V1;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{province as P, site as SM};
use frontier_abi::v2::layout::world::season as SE;
use frontier_abi::v2::layout::{write_header, AccountKind};
use frontier_abi::v2::log::{self as v2log, AnyKind, CqKind, EntityKind, Link};
use frontier_abi::v2::presets::{ConquestParams, MC_LOCAL_7D};
use permutation_rules::frontier::geometry::{region_of, ring_provinces, ProvinceCoord};
use permutation_rules::frontier::terrain::generate_province;

pub const SEASON_ID: u64 = 71;
pub const GENESIS_TS: i64 = 1_800_000_000;
pub const GENESIS_RING: u8 = 3;
pub const R_MAX: u16 = 4;
pub const CEILING: u16 = 6;
pub const GENESIS_SEED: [u8; 32] = [1; 32];
/// The wallet's home: its Holding at site 0 and its host on tile 0.
pub const HOME: (i32, i32) = (4, 0);
/// Where 8's route goes (tile 0).
pub const TARGET: (i32, i32) = (5, 0);
pub const STAGES: [&str; 4] = ["before", "extended", "opened", "grown"];

pub fn program() -> Address {
    Address::new_from_array([0x71; 32])
}

/// The fixture wallet.
pub fn wallet() -> Address {
    Address::new_from_array([0x11; 32])
}

pub fn ctx() -> AddrCtx {
    findex::addr_ctx(&program(), SEASON_ID)
}

pub fn params() -> ConquestParams {
    ConquestParams {
        r_max_ceiling: CEILING,
        placement: 0,
        continuous: 0,
        ..MC_LOCAL_7D.cq
    }
}

/// `sha256("ring" ‖ decimal d)` (8's rule).
pub fn ring_seed(d: u16) -> [u8; 32] {
    Sha256::digest(format!("ring{d}").as_bytes()).into()
}

/// The host of the wallet on (4, 0) tile 0.
pub fn host() -> u64 {
    host_id(HOME.0, HOME.1, 0, 0, 1).unwrap_or(1)
}

fn put(d: &mut [u8], o: usize, b: &[u8]) {
    d[o..o + b.len()].copy_from_slice(b);
}

fn rec(
    kind: AnyKind,
    key: &[u8],
    payload: &[u8],
    chain: &mut [(EntityKind, &mut Vec<u8>)],
) -> Vec<u8> {
    let mut p = payload.to_vec();
    p.resize(kind.payload_len(), 0);
    let mut out = vec![0u8; 512];
    let n = v2log::write_body(kind, frontier_abi::log::NO_BELL, key, &p, &mut out).unwrap_or(0);
    let bwt = out[..n].to_vec();
    let mut links: Vec<Link> = vec![];
    for (e, d) in chain.iter_mut() {
        let seq = u64::from_le_bytes(d[24..32].try_into().unwrap_or_default());
        let head: [u8; 32] = d[32..64].try_into().unwrap_or_default();
        if let Some(l) = v2log::advance(*e, seq, &head, &bwt) {
            put(d, 24, &l.seq.to_le_bytes());
            put(d, 32, &l.head);
            links.push(l);
        }
    }
    let m = v2log::write_tail(&links, &mut out, n).unwrap_or(n);
    out.truncate(m);
    out
}

struct Tx {
    txs: Vec<TxRecord>,
    seq: u64,
}

impl Tx {
    fn push(&mut self, bodies: Vec<Vec<u8>>, post: Vec<([u8; 32], Vec<u8>)>) {
        self.seq += 1;
        let mut sig = [0u8; 64];
        sig[..8].copy_from_slice(&self.seq.to_le_bytes());
        sig[8] = 0x71;
        self.txs.push(TxRecord {
            seq: self.seq,
            slot: 3_000 + self.seq,
            signature: Signature::from(sig),
            block_time: GENESIS_TS + self.seq as i64,
            tx: vec![],
            logs: fclient::log::in_frame(&program(), bodies.iter().map(|b| log_line(b))),
            err: None,
            code: None,
            units: 0,
            fee: 5_000,
            post: post
                .into_iter()
                .map(|(k, data)| {
                    (
                        Address::new_from_array(k),
                        Some(Account {
                            lamports: 1_000_000,
                            data,
                            owner: program(),
                            executable: false,
                        }),
                    )
                })
                .collect(),
        });
    }
}

fn season() -> Vec<u8> {
    let b = MC_LOCAL_7D.base;
    let mut s = vec![0u8; SE::SIZE];
    write_header(&mut s, AccountKind::Season, SEASON_ID);
    s[SE::STATUS] = SE::STATUS_RUNNING;
    s[SE::REGIONS] = b.regions;
    s[SE::GENESIS_RING] = GENESIS_RING;
    put(&mut s, SE::R_MAX, &R_MAX.to_le_bytes());
    put(
        &mut s,
        SE::RULESET_HASH,
        &frontier_abi::v2::presets::RULESET_HASH_V3,
    );
    put(
        &mut s,
        SE::RULES_VERSION,
        &frontier_abi::v2::presets::RULES_VERSION_S1.to_le_bytes(),
    );
    put(
        &mut s,
        SE::PROGRAM_VERSION,
        &frontier_abi::v2::presets::PROGRAM_VERSION_S1.to_le_bytes(),
    );
    put(&mut s, SE::BELL_SECS, &600u32.to_le_bytes());
    put(&mut s, SE::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(
        &mut s,
        SE::JOIN_CLOSE_BELL,
        &b.join_close_bell.to_le_bytes(),
    );
    put(&mut s, SE::END_BELL, &b.end_bell.to_le_bytes());
    put(&mut s, SE::GENESIS_SEED, &GENESIS_SEED);
    put(&mut s, SE::CONQUEST_PARAMS, &params().to_bytes());
    s
}

fn frontier(rings_opened: u16, r_max_ext: u16) -> Vec<u8> {
    let mut d = vec![0u8; FR::SIZE];
    write_header(&mut d, AccountKind::Frontier, SEASON_ID);
    put(&mut d, FR::RINGS_OPENED, &rings_opened.to_le_bytes());
    put(&mut d, FR::R_MAX_EXT, &r_max_ext.to_le_bytes());
    d
}

fn ring_seed_account(d: u16, status: u8, seed: [u8; 32]) -> Vec<u8> {
    let mut a = vec![0u8; RS::SIZE];
    write_header(&mut a, AccountKind::RingSeed, SEASON_ID);
    put(&mut a, RS::D, &d.to_le_bytes());
    a[RS::STATUS] = status;
    put(&mut a, RS::SEED, &seed);
    a
}

/// A Province v2 as OpenProvince writes it (terrain, sites, passable mask
/// and keep from the ring seed), the wallet's holding and host at HOME.
fn province(c: ProvinceCoord) -> Vec<u8> {
    let seed = ring_seed(c.ring() as u16);
    let t = generate_province(&seed, c);
    let mut pd = vec![0u8; P::SIZE];
    write_header(&mut pd, AccountKind::Province, SEASON_ID);
    put(&mut pd, P::P, &(c.p as i16).to_le_bytes());
    put(&mut pd, P::Q, &(c.q as i16).to_le_bytes());
    put(&mut pd, P::RING, &(c.ring() as u16).to_le_bytes());
    pd[P::WEDGE] = c.wedge().unwrap_or(0);
    pd[P::REGION] = region_of(c);
    let mut passable = 0u64;
    for i in 0..61u8 {
        let k = i as usize;
        pd[P::TERRAIN + k] = TERRAINS
            .iter()
            .position(|x| *x == t.terrain[k])
            .unwrap_or(0) as u8;
        pd[P::RESOURCE + k] = match t.resource[k] {
            None => 0,
            Some(r) => 1 + cm::RESOURCES.iter().position(|x| *x == r).unwrap_or(0) as u8,
        };
        if t.passable(i) {
            passable |= 1 << i;
        }
    }
    put(&mut pd, P::SITES, &t.sites);
    pd[P::SITE_COUNT] = t.site_count;
    put(&mut pd, P::PASSABLE_MASK, &passable.to_le_bytes());
    for s in 0..12 {
        let o = P::site(s);
        put(&mut pd, o + SM::PEND0_BELL, &SM::NO_BELL.to_le_bytes());
        put(&mut pd, o + SM::PEND1_BELL, &SM::NO_BELL.to_le_bytes());
    }
    let camp = cm::Camp {
        tile: 0,
        state: 0,
        troops: 0,
        next_check_day: 1_000,
        gen: 0,
    };
    camp.write(&mut pd).expect("camp");
    let w = c.wedge().unwrap_or(0);
    let keep = kkeep::keep_tile(&t, &t.sites, t.site_count, w)
        .filter(|_| c.ring() >= 2)
        .and_then(|tile| {
            kkeep::open(
                c,
                w,
                params().heartland_max_ring,
                tile,
                &params().keep_params(),
                0,
            )
        });
    match keep {
        Some(k) => qm::write_keep(&mut pd, &k).expect("keep"),
        None => qm::write_no_keep(&mut pd).expect("no keep"),
    }
    if (c.p, c.q) == HOME {
        let o = P::site(0);
        pd[o + SM::STATE] = SM::STATE_HOLDING;
        pd[o + SM::FACTION] = 1;
        let e = Entry {
            id: host(),
            faction: 1,
            unit: 0,
            tile: 0,
            state: E::STATE_ROSTER,
            troops: 500_000,
            stamina_value: 120,
            dealt_bps: 10_000,
            stamina_bell: 0,
            ready_bell: 0,
            from_bell: 0,
            pend_bell: 0,
            op: EntryOp::None,
        };
        write_entry(&mut pd, 0, &e).expect("entry");
        pd[P::N_ENTRIES] = 1;
    }
    pd
}

fn citizen(addr: &[u8; 32]) -> Vec<u8> {
    let mut d = vec![0u8; C2::SIZE];
    write_header(&mut d, AccountKind::Citizen, SEASON_ID);
    put(&mut d, C2::WALLET, &wallet().to_bytes());
    d[C2::FACTION] = 1;
    d[C2::HOLDINGS_N] = 1;
    // HoldingRef {P i16, Q i16, site u8, gen u8} x3; unused: gen 255.
    put(&mut d, C2::HOLDING, &(HOME.0 as i16).to_le_bytes());
    put(&mut d, C2::HOLDING + 2, &(HOME.1 as i16).to_le_bytes());
    d[C2::HOLDING + 4] = 0;
    d[C2::HOLDING + 5] = 0;
    for i in 1..3 {
        d[C2::HOLDING + 6 * i + 5] = 255;
    }
    put(&mut d, C2::TICKET_BELL, &u32::MAX.to_le_bytes());
    put(&mut d, C2::CITIZEN_TAG, &addr[..8]);
    d
}

fn holding(owner: &[u8; 32], tile: u8) -> Vec<u8> {
    let mut d = vec![0u8; H2::SIZE];
    write_header(&mut d, AccountKind::Holding, SEASON_ID);
    put(&mut d, H2::P, &(HOME.0 as i16).to_le_bytes());
    put(&mut d, H2::Q, &(HOME.1 as i16).to_le_bytes());
    d[H2::SITE] = 0;
    d[H2::TILE] = tile;
    d[H2::STATE] = 1;
    put(&mut d, H2::OWNER_CITIZEN, owner);
    d[H2::FACTION] = 1;
    put(&mut d, H2::FOUNDED_TS, &GENESIS_TS.to_le_bytes());
    d
}

/// The archive and where each stage ends (`txs[..ends[k]]`).
pub fn map_growth() -> (Vec<TxRecord>, [usize; 4]) {
    let cx = ctx();
    let mut t = Tx {
        txs: vec![],
        seq: 0,
    };
    let sid = SEASON_ID.to_le_bytes();
    let mut se = season();
    let created = rec(
        AnyKind::V1(V1::SEASON_CREATED),
        &sid,
        &[],
        &mut [(EntityKind::Season, &mut se)],
    );
    t.push(vec![created], vec![(cx.season, se)]);

    // before: rings 0..=4 seeded and every Province on chain.
    let mut fr = frontier(0, 0);
    for d in 0..=R_MAX {
        put(&mut fr, FR::RINGS_OPENED, &(d + 1).to_le_bytes());
        let seed = ring_seed(d);
        let mut payload = vec![0u8; 16];
        payload.extend(seed);
        let open = rec(
            AnyKind::V1(V1::RING_OPEN),
            &d.to_le_bytes(),
            &payload,
            &mut [(EntityKind::Frontier, &mut fr)],
        );
        t.push(
            vec![open],
            vec![
                (cx.ring_seed(d), ring_seed_account(d, 2, seed)),
                (cx.frontier(), fr.clone()),
            ],
        );
    }
    let open_ring = |t: &mut Tx, d: u16| {
        for c in ring_provinces(d as u32) {
            let mut pd = province(c);
            let key = [c.p.to_le_bytes(), c.q.to_le_bytes()].concat();
            let mut payload = (c.ring() as u16).to_le_bytes().to_vec();
            payload.extend([c.wedge().unwrap_or(0), region_of(c)]);
            let body = rec(
                AnyKind::V1(V1::PROVINCE_OPEN),
                &key,
                &payload,
                &mut [(EntityKind::Province, &mut pd)],
            );
            t.push(vec![body], vec![(cx.province(c.p, c.q), pd)]);
        }
    };
    for d in 0..=R_MAX {
        open_ring(&mut t, d);
    }
    let caddr = cx.citizen(&wallet().to_bytes());
    let home = generate_province(&ring_seed(4), ProvinceCoord::new(HOME.0, HOME.1));
    t.push(
        vec![],
        vec![
            (caddr, citizen(&caddr)),
            (
                cx.holding(HOME.0, HOME.1, 0),
                holding(&caddr, home.sites[0]),
            ),
        ],
    );
    let e0 = t.txs.len();

    // extended: ExtendFrontier(5).
    put(&mut fr, FR::R_MAX_EXT, &(R_MAX + 1).to_le_bytes());
    let mut payload = R_MAX.to_le_bytes().to_vec();
    payload.extend(CEILING.to_le_bytes());
    let ext = rec(
        AnyKind::Cq(CqKind::FRONTIER_EXTENDED),
        &(R_MAX + 1).to_le_bytes(),
        &payload,
        &mut [(EntityKind::Frontier, &mut fr)],
    );
    t.push(vec![ext], vec![(cx.frontier(), fr.clone())]);
    let e1 = t.txs.len();

    // opened: OpenRing(5), its seed requested.
    let d = R_MAX + 1;
    put(&mut fr, FR::RINGS_OPENED, &(d + 1).to_le_bytes());
    let open = rec(
        AnyKind::V1(V1::RING_OPEN),
        &d.to_le_bytes(),
        &[],
        &mut [(EntityKind::Frontier, &mut fr)],
    );
    t.push(
        vec![open],
        vec![
            (cx.ring_seed(d), ring_seed_account(d, 1, [0; 32])),
            (cx.frontier(), fr.clone()),
        ],
    );
    let e2 = t.txs.len();

    // grown: ConsumeRingSeed(5) and the ring's 30 Provinces.
    let seed = ring_seed(d);
    let mut payload = vec![0u8; 8];
    payload.extend(seed);
    let consumed = rec(
        AnyKind::V1(V1::RING_SEED),
        &d.to_le_bytes(),
        &payload,
        &mut [],
    );
    t.push(
        vec![consumed],
        vec![(cx.ring_seed(d), ring_seed_account(d, 2, seed))],
    );
    open_ring(&mut t, d);
    let e3 = t.txs.len();
    (t.txs, [e0, e1, e2, e3])
}
