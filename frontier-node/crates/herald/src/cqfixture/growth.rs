//! An S1 (layout 2) map-growth archive (⑲, 2026-11-08): ring 4 → ring 5
//! with ExtendFrontier, to workstream 8's contract
//! (`permutation-gateway/test/fixtures/frontier/growth-route.mjs`, branch
//! `claude/festive-tesla-iwwc5t` 5e7ac44c), for the router golden
//! `tests/golden/ws19-map-growth-s1.json` (`tests/ws19_map_contract.rs`).
//!
//! Season 71: program_version 4, the S1 ruleset (`RULESET_HASH_V3`),
//! `MC_LOCAL_7D`'s conquest block with `r_max_ceiling` 6, placement 0,
//! not continuous; genesis ring 3, Season `r_max` 4, genesis seed `[1; 32]`.
//! Ring seeds: rings `0..=genesis_ring` are seeded at open with the
//! program's genesis rule `sha256("PSF-RING" ‖ genesis_seed ‖ le16 d)`
//! (permutation-frontier `proc/map.rs` `genesis_ring_seed`, I-30); rings
//! above take `sha256("ring" ‖ d)` standing in for the beacon round's seed
//! (8's rule, growth-route.mjs 4eeb6c7f). Province terrain, sites and passable mask come from
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
//! From the first stage on, an NFT resident (workstream 20) too: a Citizen
//! marked with `resident_citizen::mark` for [`resident_asset`] at the
//! resident-id address, with its Holding at HOME site 1.
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

/// Ring `d`'s seed: a genesis ring's from the genesis seed (I-30), a
/// crowding ring's `sha256("ring" ‖ decimal d)` (8's stand-in).
pub fn ring_seed(d: u16) -> [u8; 32] {
    if d <= GENESIS_RING as u16 {
        Sha256::digest([RS::GENESIS_RING_DOMAIN, &GENESIS_SEED, &d.to_le_bytes()].concat()).into()
    } else {
        Sha256::digest(format!("ring{d}").as_bytes()).into()
    }
}

/// An NFT resident's asset (a fixed public pattern: an address, not a key).
pub fn resident_asset() -> Address {
    Address::new_from_array([0xA5; 32])
}

/// The NFT resident's Citizen: `citizen_by_tag15(resident_tag15(asset))`.
pub fn resident_citizen() -> [u8; 32] {
    ctx().citizen_by_tag15(&frontier_abi::resident_citizen::resident_tag15(
        &resident_asset().to_bytes(),
    ))
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
    rec_at(kind, frontier_abi::log::NO_BELL, key, payload, chain)
}

/// A record at `bell` (the bell the instruction landed in).
fn rec_at(
    kind: AnyKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    chain: &mut [(EntityKind, &mut Vec<u8>)],
) -> Vec<u8> {
    let mut p = payload.to_vec();
    p.resize(kind.payload_len(), 0);
    let mut out = vec![0u8; 512];
    let n = v2log::write_body(kind, bell, key, &p, &mut out).unwrap_or(0);
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
    /// Every account's latest posted bytes (a later write starts from them).
    last: std::collections::BTreeMap<[u8; 32], Vec<u8>>,
}

impl Tx {
    fn push(&mut self, bodies: Vec<Vec<u8>>, post: Vec<([u8; 32], Vec<u8>)>) {
        for (k, d) in &post {
            self.last.insert(*k, d.clone());
        }
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

/// The season's CreateSeason parameters: `MC_LOCAL_7D` (the S1 exit's
/// preset) with 8's map (genesis ring 3, `r_max` 4, ceiling 6) and the S1
/// program's version. The program refuses any other lead window, reveal
/// window or schedule (`SeasonParamsV2::validate`: `min_lead` 2,
/// `max_lead` 72, …), so nothing here is chosen by the fixture.
pub fn season_params() -> frontier_abi::v2::presets::SeasonParamsV2 {
    frontier_abi::v2::presets::SeasonParamsV2 {
        base: frontier_abi::presets::SeasonParams {
            genesis_ring: GENESIS_RING,
            r_max: R_MAX,
            program_version: frontier_abi::v2::presets::PROGRAM_VERSION_S1,
            ..MC_LOCAL_7D.base
        },
        cq: params(),
    }
}

/// The Season as CreateSeason writes it (permutation-frontier
/// `proc/season.rs` `write_params`, field for field from
/// [`season_params`]), then seeded and running. Not written: the
/// authority, bump, bond and announce fields, `GENESIS_ROUND`, the payout
/// hash (left zero; the map reads none of them).
pub fn season_bytes_from(sp: &frontier_abi::v2::presets::SeasonParamsV2) -> Vec<u8> {
    let p = sp.base;
    let mut s = vec![0u8; SE::SIZE];
    write_header(&mut s, AccountKind::Season, SEASON_ID);
    s[SE::STATUS] = SE::STATUS_RUNNING;
    s[SE::REGIONS] = p.regions;
    s[SE::GENESIS_RING] = p.genesis_ring;
    put(&mut s, SE::R_MAX, &p.r_max.to_le_bytes());
    s[SE::OFFICE_TERMS_PER_WALLET] = p.office_terms_per_wallet;
    s[SE::POSTURES_ENABLED] = p.postures_enabled;
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
        &p.program_version.to_le_bytes(),
    );
    put(&mut s, SE::BELL_SECS, &p.bell_secs.to_le_bytes());
    put(&mut s, SE::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(&mut s, SE::CREATED_TS, &(GENESIS_TS - 3_600).to_le_bytes());
    put(
        &mut s,
        SE::JOIN_CLOSE_BELL,
        &p.join_close_bell.to_le_bytes(),
    );
    put(&mut s, SE::END_BELL, &p.end_bell.to_le_bytes());
    put(&mut s, SE::DRAND_GENESIS, &p.drand_genesis.to_le_bytes());
    put(&mut s, SE::DRAND_PERIOD, &p.drand_period.to_le_bytes());
    s[SE::NETWORK] = p.network;
    put(&mut s, SE::QUICKNET_PK_HASH, &p.quicknet_pk_hash);
    put(&mut s, SE::REVEAL_WINDOW, &p.reveal_window.to_le_bytes());
    put(&mut s, SE::SEED_MARGIN, &p.seed_margin.to_le_bytes());
    put(&mut s, SE::WINDOW_NEXT, &p.reveal_window.to_le_bytes());
    put(&mut s, SE::WINDOW_FROM_BELL, &SE::WINDOW_NONE.to_le_bytes());
    put(&mut s, SE::GENESIS_SEED, &GENESIS_SEED);
    put(&mut s, SE::ARCHIVE_AFTER, &p.archive_after.to_le_bytes());
    s[SE::MIN_LEAD] = p.min_lead;
    s[SE::MAX_LEAD] = p.max_lead;
    s[SE::TRANSIT_SLOTS] = p.transit_slots;
    put(&mut s, SE::MARCH_FEE, &p.march_fee.to_le_bytes());
    put(&mut s, SE::SEAL_BOND, &p.seal_bond.to_le_bytes());
    put(
        &mut s,
        SE::MIN_REVEAL_PRIORITY_MILLI,
        &p.min_reveal_priority_milli.to_le_bytes(),
    );
    put(
        &mut s,
        SE::REVEAL_CU_LIMIT,
        &p.reveal_cu_limit.to_le_bytes(),
    );
    put(
        &mut s,
        SE::BUCKET_RATE_PER_H,
        &p.bucket_rate_per_h.to_le_bytes(),
    );
    put(&mut s, SE::BUCKET_BURST, &p.bucket_burst.to_le_bytes());
    put(
        &mut s,
        SE::DEFENCE_CAP_MILLI,
        &p.defence_cap_milli.to_le_bytes(),
    );
    s[SE::LATENESS_SLOTS] = p.lateness_slots;
    put(
        &mut s,
        SE::THETA_EARLY_BPS,
        &p.theta_early_bps.to_le_bytes(),
    );
    put(&mut s, SE::THETA_LATE_BPS, &p.theta_late_bps.to_le_bytes());
    put(
        &mut s,
        SE::THETA_SWITCH_SECS,
        &p.theta_switch_secs.to_le_bytes(),
    );
    put(&mut s, SE::RESERVE_BPS, &p.reserve_bps.to_le_bytes());
    put(&mut s, SE::EXTRA_FREE_BPS, &p.extra_free_bps.to_le_bytes());
    put(
        &mut s,
        SE::CLASH_CLOSE_GRACE,
        &p.clash_close_grace.to_le_bytes(),
    );
    put(
        &mut s,
        SE::CAMP_REGROW_BELLS,
        &p.camp_regrow_bells.to_le_bytes(),
    );
    put(
        &mut s,
        SE::DORMANT_AFTER_SECS,
        &p.dormant_after_secs.to_le_bytes(),
    );
    put(
        &mut s,
        SE::RELEASE_AFTER_SECS,
        &p.release_after_secs.to_le_bytes(),
    );
    put(&mut s, SE::PFUND_INITIAL, &p.pfund_initial.to_le_bytes());
    put(&mut s, SE::DPOOL_INITIAL, &p.dpool_initial.to_le_bytes());
    put(
        &mut s,
        SE::REVEAL_LOADED_LIMIT,
        &p.reveal_loaded_limit.to_le_bytes(),
    );
    put(&mut s, SE::JOIN_GATE, &p.join_gate);
    put(&mut s, SE::CONQUEST_PARAMS, &sp.cq.to_bytes());
    s
}

fn season() -> Vec<u8> {
    season_bytes_from(&season_params())
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
        for (s, f) in [(0, 1), (1, 2)] {
            let o = P::site(s);
            pd[o + SM::STATE] = SM::STATE_HOLDING;
            pd[o + SM::FACTION] = f;
        }
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

fn citizen(addr: &[u8; 32], site: u8, faction: u8) -> Vec<u8> {
    let mut d = vec![0u8; C2::SIZE];
    write_header(&mut d, AccountKind::Citizen, SEASON_ID);
    put(&mut d, C2::WALLET, &wallet().to_bytes());
    d[C2::FACTION] = faction;
    d[C2::HOLDINGS_N] = 1;
    // HoldingRef {P i16, Q i16, site u8, gen u8} x3; unused: gen 255.
    put(&mut d, C2::HOLDING, &(HOME.0 as i16).to_le_bytes());
    put(&mut d, C2::HOLDING + 2, &(HOME.1 as i16).to_le_bytes());
    d[C2::HOLDING + 4] = site;
    d[C2::HOLDING + 5] = 0;
    for i in 1..3 {
        d[C2::HOLDING + 6 * i + 5] = 255;
    }
    put(&mut d, C2::TICKET_BELL, &u32::MAX.to_le_bytes());
    put(&mut d, C2::CITIZEN_TAG, &addr[..8]);
    d
}

fn holding(owner: &[u8; 32], site: u8, tile: u8, faction: u8) -> Vec<u8> {
    let mut d = vec![0u8; H2::SIZE];
    write_header(&mut d, AccountKind::Holding, SEASON_ID);
    put(&mut d, H2::P, &(HOME.0 as i16).to_le_bytes());
    put(&mut d, H2::Q, &(HOME.1 as i16).to_le_bytes());
    d[H2::SITE] = site;
    d[H2::TILE] = tile;
    d[H2::STATE] = 1;
    put(&mut d, H2::OWNER_CITIZEN, owner);
    d[H2::FACTION] = faction;
    put(&mut d, H2::FOUNDED_TS, &GENESIS_TS.to_le_bytes());
    d
}

/// The archive and where each stage ends (`txs[..ends[k]]`).
pub fn map_growth() -> (Vec<TxRecord>, [usize; 4]) {
    let (t, ends) = growth_tx();
    (t.txs, ends)
}

fn growth_tx() -> (Tx, [usize; 4]) {
    let cx = ctx();
    let mut t = Tx {
        last: Default::default(),
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
            let mut bodies = vec![body];
            // OpenProvince's KEEP record (permutation-frontier proc/map.rs,
            // right after PROVINCE_OPEN in the same instruction, chained to
            // the Province): cause PLACED, the holder, from NONE, troops,
            // consolidated_until_bell, gen, read back from the keep the
            // Province now holds (none for rings 0-1 or without a keep tile).
            if let Ok(Some(k)) = qm::read_keep(&pd) {
                let mut kp = vec![
                    frontier_abi::v2::log::keep_cause::PLACED,
                    k.holder,
                    kkeep::NONE,
                ];
                kp.extend(k.troops.to_le_bytes());
                kp.extend(k.consolidated_until_bell.to_le_bytes());
                kp.extend(k.gen.to_le_bytes());
                bodies.push(rec(
                    AnyKind::Cq(CqKind::KEEP),
                    &key,
                    &kp,
                    &mut [(EntityKind::Province, &mut pd)],
                ));
            }
            t.push(bodies, vec![(cx.province(c.p, c.q), pd)]);
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
            (caddr, citizen(&caddr, 0, 1)),
            (
                cx.holding(HOME.0, HOME.1, 0),
                holding(&caddr, 0, home.sites[0], 1),
            ),
        ],
    );
    // An NFT resident (workstream 20): the Citizen at the resident-id
    // address, marked with `resident_citizen::mark` (WALLET zero, the asset,
    // the flag), its Holding at HOME site 1.
    let asset = resident_asset().to_bytes();
    let raddr = resident_citizen();
    let mut rc = citizen(&raddr, 1, 2);
    assert!(frontier_abi::resident_citizen::mark(&mut rc, &asset));
    t.push(
        vec![],
        vec![
            (raddr, rc),
            (
                cx.holding(HOME.0, HOME.1, 1),
                holding(&raddr, 1, home.sites[1], 2),
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
    (t, [e0, e1, e2, e3])
}

/// The palisade of [`palisade_case`]: `(P, Q, tile)` on 8's route from
/// HOME tile 0 to TARGET tile 0 (growth-route.mjs `ROUTE.dirs`), the first
/// hex of the walk where BuildStructure may stand one (passable, not a
/// site, not the keep, no camp present), the destination excluded.
pub const ROUTE_DIRS: [u8; 9] = [0, 0, 0, 0, 1, 1, 0, 1, 1];

/// The tiles 8's route walks through, in order (origin excluded).
pub fn route_tiles() -> Vec<(i32, i32, u8)> {
    use permutation_rules::frontier::geometry::locate;
    use permutation_rules::hex::{Hex, DIRECTIONS};
    let mut h = ProvinceCoord::new(HOME.0, HOME.1).tile(0).expect("tile 0");
    ROUTE_DIRS
        .iter()
        .map(|&d| {
            let (dq, dr) = DIRECTIONS[d as usize];
            h = Hex::new(h.q + dq, h.r + dr);
            let (pc, t) = locate(h);
            (pc.p, pc.q, t)
        })
        .collect()
}

/// Where the palisade stands (see [`ROUTE_DIRS`]).
pub fn palisade_at() -> (i32, i32, u8) {
    let tiles = route_tiles();
    let last = tiles.len() - 1;
    tiles[..last]
        .iter()
        .copied()
        .find(|&(p, q, tile)| {
            let c = ProvinceCoord::new(p, q);
            let t = generate_province(&ring_seed(c.ring() as u16), c);
            let w = c.wedge().unwrap_or(0);
            let keep = kkeep::keep_tile(&t, &t.sites, t.site_count, w).filter(|_| c.ring() >= 2);
            // The camp, from the Province bytes the fixture writes (build_structure: `camp_present && camp == tile`).
            let pd = province(c);
            let cp = P::CAMP;
            let camp_here = pd[cp + frontier_abi::layout::province::camp::STATE]
                == frontier_abi::layout::province::camp::STATE_PRESENT
                && pd[cp + frontier_abi::layout::province::camp::TILE] == tile;
            t.passable(tile)
                && !t.sites[..t.site_count as usize].contains(&tile)
                && keep != Some(tile)
                && !camp_here
        })
        .expect("a buildable hex on the route")
}

/// A second, independent case (the empty-world [`map_growth`] is
/// unchanged): the grown world, then one BuildStructure(palisade) by the
/// fixture's faction-2 Citizen (the NFT resident, its Holding at HOME
/// site 1) on [`palisade_at`], as `proc/structure.rs build_structure`
/// writes it: the Structure account (STATE_LIVE, gen 1, the owner's tag,
/// notify owner, entry 0, kind palisade), the Province's structure entry 0,
/// the Citizen's PALISADES counter, and STRUCTURE_BUILT chained to the
/// Citizen, Holding, Province and Structure. **Not modelled:** the Holding's
/// payment (`kt::cost(PALISADE)` from its stores through the economy
/// kernel); the Holding is not reposted, so its published chain head lags
/// the STRUCTURE_BUILT link to it (16's review, REPORT §29.31). Also left
/// as the fixture's: the Structure's RENT_TO (the program writes the
/// payer's key; zero here). Scene choices no definition fixes, made for
/// this case only: the builder (the existing faction-2 Citizen), notify
/// (NOTIFY_OWNER) and the hex (the first buildable one on the route). A palisade of faction 2 stops a
/// faction-1 march by the existing stance rule (`s1walk.mjs stops`: another
/// nation at war; a fresh season's stances are all war). `ends[0]` is the
/// grown world, `ends[1]` the build.
pub fn palisade_case() -> (Vec<TxRecord>, [usize; 2]) {
    use frontier_abi::v2::layout::player::citizen as C2s;
    use frontier_abi::v2::layout::province::structure_entry as TE;
    use frontier_abi::v2::layout::s1::structure as TW;
    let cx = ctx();
    let (mut t, ends) = growth_tx();
    let grown = ends[3];
    let (p, q, tile) = palisade_at();
    let raddr = resident_citizen();
    let mut rc = t.last[&raddr].clone();
    let haddr = cx.holding(HOME.0, HOME.1, 1);
    let mut hd = t.last[&haddr].clone();
    let paddr = cx.province(p, q);
    let mut pd = t.last[&paddr].clone();
    let saddr = frontier_abi::v2::addr::structure(&cx, p, q, tile);
    let faction = rc[C2::FACTION];
    let owner_tag =
        u64::from_le_bytes(rc[C2::CITIZEN_TAG..C2::CITIZEN_TAG + 8].try_into().unwrap());
    let mut sd = vec![0u8; TW::SIZE];
    write_header(&mut sd, AccountKind::Structure, SEASON_ID);
    put(&mut sd, TW::P, &(p as i16).to_le_bytes());
    put(&mut sd, TW::Q, &(q as i16).to_le_bytes());
    sd[TW::TILE] = tile;
    sd[TW::STATE] = TW::STATE_LIVE;
    sd[TW::FACTION] = faction;
    sd[TW::GEN] = 1;
    put(&mut sd, TW::OWNER_CITIZEN, &raddr);
    put(&mut sd, TW::OWNER_TAG, &owner_tag.to_le_bytes());
    put(&mut sd, TW::BUILT_TS, &(GENESIS_TS + 300).to_le_bytes());
    put(
        &mut sd,
        TW::SEIZED_BELL,
        &frontier_abi::log::NO_BELL.to_le_bytes(),
    );
    sd[TW::NOTIFY] = TW::NOTIFY_OWNER;
    sd[TW::ENTRY] = 0;
    sd[TW::KIND] = TW::KIND_PALISADE;
    let o = TE::at(0);
    pd[o + TE::KIND] = TW::KIND_PALISADE;
    pd[o + TE::TILE] = tile;
    pd[o + TE::FACTION] = faction;
    pd[o + TE::GEN] = 1;
    rc[C2s::PALISADES] += 1;
    let cost = permutation_rules::frontier::structure::cost(TW::KIND_PALISADE);
    let mut cb = [0u8; 64];
    for (i, v) in cost.iter().enumerate() {
        cb[8 * i..8 * i + 8].copy_from_slice(&v.to_le_bytes());
    }
    let digest: [u8; 32] = Sha256::digest(cb).into();
    let hkey = host_id(HOME.0, HOME.1, 1, 0, 0).unwrap_or(0);
    let mut payload = owner_tag.to_le_bytes().to_vec();
    payload.extend([faction, 1, 0, TW::NOTIFY_OWNER]);
    payload.extend(hkey.to_le_bytes());
    payload.extend(digest);
    payload.push(TW::KIND_PALISADE);
    let mut key = p.to_le_bytes().to_vec();
    key.extend(q.to_le_bytes());
    key.push(tile);
    // BuildStructure lands at GENESIS_TS + 300: bell 0.
    let built = rec_at(
        AnyKind::Cq(CqKind::STRUCTURE_BUILT),
        0,
        &key,
        &payload,
        &mut [
            (EntityKind::Citizen, &mut rc),
            (EntityKind::Holding, &mut hd),
            (EntityKind::Province, &mut pd),
            (EntityKind::Structure, &mut sd),
        ],
    );
    t.push(vec![built], vec![(raddr, rc), (paddr, pd), (saddr, sd)]);
    let e = t.txs.len();
    (t.txs, [grown, e])
}
