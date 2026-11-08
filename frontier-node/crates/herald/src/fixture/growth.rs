//! A map-growth archive (⑲, 2026-11-08): the world before and after
//! OpenRing, as the program and the keeper put it on chain, for the map
//! contract test (`tests/ws19_map_contract.rs`) and the client golden.
//!
//! Unlike [`super::mini_season`] (rings 2 and 3 only, no Frontier) the rings
//! here are the contiguous prefix OpenRing allows (`d == rings_opened`), and
//! the Frontier account carries `rings_opened`:
//!
//! - **S0** (before growth): genesis ring 1, so rings 0 and 1 are seeded at
//!   open (RING_OPEN with `sha256("PSF-RING" ‖ genesis_seed ‖ le16 d)`,
//!   RingSeed status 2); Frontier `rings_opened = 2`. Provinces on chain:
//!   (0, 0) and ring 1 but [`NEVER_OPENED`]. The fixture wallet's Citizen and
//!   its Holding at [`HOME`] site 0.
//! - **S1** (OpenRing 2): RING_OPEN with no seed, RingSeed 2 status 1
//!   (requested), Frontier `rings_opened = 3`. The seed is missing.
//! - **S2** (ConsumeRingSeed 2): RING_SEED with the seed, RingSeed status 2;
//!   [`RING2_OPENED`] put on chain, the other ten of ring 2 not.
//!
//! Season `r_max` 3 (ring 3 unopened, ring 4 outside), M1 accounts (v1
//! layout, no conquest block: no ceiling). Keyless: fixed byte-pattern
//! signatures, no transaction bytes; the addresses are the public PDAs of
//! [`super::ctx`].

use sha2::{Digest, Sha256};

use fclient::ports::TxRecord;
use frontier_abi::layout::{self as L, AccountKind};
use frontier_abi::log::{self as plog, EntityKind, Kind};
use permutation_rules::frontier::geometry::{region_of, ProvinceCoord};

use super::{body, ctx, le32, new_account, pad, put, wallet, B, GENESIS_TS, SEASON_ID};

/// The season's genesis ring here (rings `0..=GENESIS_RING` seed at open).
pub const GENESIS_RING: u8 = 1;
/// The season's outermost ring.
pub const R_MAX: u16 = 3;
/// The genesis seed (a fixed public pattern).
pub const GENESIS_SEED: [u8; 32] = [0x47; 32];
/// The ring-1 Province never put on chain.
pub const NEVER_OPENED: (i16, i16) = (1, -1);
/// The fixture wallet's home (its Holding at site 0).
pub const HOME: (i16, i16) = (1, 0);
/// The ring-2 Provinces on chain after S2.
pub const RING2_OPENED: [(i16, i16); 2] = [(2, 0), (1, 1)];
/// The stages, in order: `(name, transactions through the stage's end)`.
pub const STAGES: [&str; 3] = ["S0", "S1", "S2"];

/// The seed of ring `d` (a genesis ring's from the genesis seed, I-30; a
/// crowding ring's a fixed pattern standing in for the beacon round's).
pub fn ring_seed(d: u16) -> [u8; 32] {
    if d <= GENESIS_RING as u16 {
        Sha256::digest(
            [
                L::world::ring_seed::GENESIS_RING_DOMAIN,
                &GENESIS_SEED,
                &d.to_le_bytes(),
            ]
            .concat(),
        )
        .into()
    } else {
        Sha256::digest([b"ws19/ring".as_slice(), &d.to_le_bytes()].concat()).into()
    }
}

fn season() -> Vec<u8> {
    use L::world::season as S;
    let mut d = super::season_account();
    d[S::GENESIS_RING] = GENESIS_RING;
    put(&mut d, S::R_MAX, &R_MAX.to_le_bytes());
    put(&mut d, S::GENESIS_SEED, &GENESIS_SEED);
    d
}

fn frontier(rings_opened: u16) -> Vec<u8> {
    use L::world::frontier as F;
    let mut d = new_account(AccountKind::Frontier);
    put(&mut d, F::RINGS_OPENED, &rings_opened.to_le_bytes());
    d
}

fn ring_seed_account(d: u16, status: u8, seed: [u8; 32]) -> Vec<u8> {
    use L::world::ring_seed as R;
    let mut a = new_account(AccountKind::RingSeed);
    put(&mut a, R::D, &d.to_le_bytes());
    a[R::STATUS] = status;
    put(&mut a, R::SEED, &seed);
    a
}

fn province(p: i16, q: i16) -> Vec<u8> {
    use L::province::{province as P, site as S};
    let c = ProvinceCoord::new(p as i32, q as i32);
    let ring = c.ring() as u16;
    let mut d = super::province_account(p, q, ring, region_of(c));
    d[P::WEDGE] = c.wedge().unwrap_or(0);
    if (p, q) == HOME {
        let o = P::SITE_MIRROR;
        d[o + S::STATE] = S::STATE_HOLDING;
        d[o + S::FACTION] = 1;
        put(&mut d, o + S::GARRISON, &200_000u32.to_le_bytes());
    }
    d
}

fn citizen(addr: &[u8; 32]) -> Vec<u8> {
    use L::player::citizen as C;
    let mut d = super::citizen_account(addr);
    put(&mut d, C::HOLDING, &HOME.0.to_le_bytes());
    put(&mut d, C::HOLDING + 2, &HOME.1.to_le_bytes());
    d
}

fn holding(citizen: &[u8; 32]) -> Vec<u8> {
    use L::player::holding as H;
    let mut d = new_account(AccountKind::Holding);
    put(&mut d, H::P, &HOME.0.to_le_bytes());
    put(&mut d, H::Q, &HOME.1.to_le_bytes());
    d[H::TILE] = 5;
    d[H::STATE] = 2;
    put(&mut d, H::OWNER_CITIZEN, citizen);
    d[H::FACTION] = 1;
    d
}

/// The archive and where each stage ends (`ends[k]`: the transactions of
/// stages `0..=k` are `txs[..ends[k]]`).
pub fn map_growth() -> (Vec<TxRecord>, [usize; 3]) {
    let cx = ctx();
    let mut b = B {
        txs: vec![],
        seq: 0,
        slot: 2_000,
    };
    let sid = SEASON_ID.to_le_bytes();
    let mut se = season();
    let mut sc = vec![0u8; 32];
    sc.extend(1u64.to_le_bytes());
    sc.extend(GENESIS_TS.to_le_bytes());
    sc.extend(frontier_abi::presets::RULESET_HASH);
    let created = body(
        Kind::SEASON_CREATED,
        plog::NO_BELL,
        &sid,
        &pad(Kind::SEASON_CREATED, sc),
        &mut [(EntityKind::Season, &mut se)],
    );
    b.tx(
        GENESIS_TS - 1_000,
        vec![created],
        vec![(cx.season, Some(se))],
        false,
    );

    // S0: the genesis rings, seeded at open; the Frontier counts them.
    let mut fr = frontier(0);
    for d in 0..=GENESIS_RING as u16 {
        put(
            &mut fr,
            L::world::frontier::RINGS_OPENED,
            &(d + 1).to_le_bytes(),
        );
        let seed = ring_seed(d);
        let mut payload = vec![0u8; 16];
        payload.extend(seed);
        let open = body(
            Kind::RING_OPEN,
            plog::NO_BELL,
            &d.to_le_bytes(),
            &payload,
            &mut [(EntityKind::Frontier, &mut fr)],
        );
        b.tx(
            GENESIS_TS - 900,
            vec![open],
            vec![
                (cx.ring_seed(d), Some(ring_seed_account(d, 2, seed))),
                (cx.frontier(), Some(fr.clone())),
            ],
            false,
        );
    }
    let ring1 = permutation_rules::frontier::geometry::ring_provinces(1);
    let s0: Vec<(i16, i16)> = std::iter::once((0, 0))
        .chain(ring1.iter().map(|c| (c.p as i16, c.q as i16)))
        .filter(|pq| *pq != NEVER_OPENED)
        .collect();
    let open_provinces = |b: &mut B, list: &[(i16, i16)]| {
        for &(p, q) in list {
            let mut d = province(p, q);
            let c = ProvinceCoord::new(p as i32, q as i32);
            let key = [le32(p as i32), le32(q as i32)].concat();
            let mut payload = (c.ring() as u16).to_le_bytes().to_vec();
            payload.extend([c.wedge().unwrap_or(0), region_of(c)]);
            let r = body(
                Kind::PROVINCE_OPEN,
                plog::NO_BELL,
                &key,
                &pad(Kind::PROVINCE_OPEN, payload),
                &mut [(EntityKind::Province, &mut d)],
            );
            b.tx(
                GENESIS_TS - 800,
                vec![r],
                vec![(cx.province(p as i32, q as i32), Some(d))],
                false,
            );
        }
    };
    open_provinces(&mut b, &s0);
    let caddr = cx.citizen(&wallet().to_bytes());
    let mut ci = citizen(&caddr);
    let mut ho = holding(&caddr);
    let mut jp = wallet().to_bytes().to_vec();
    jp.extend([1u8, 0]);
    let join = body(
        Kind::JOIN,
        plog::NO_BELL,
        &caddr[..15],
        &pad(Kind::JOIN, jp),
        &mut [(EntityKind::Citizen, &mut ci)],
    );
    let settle_key = [le32(HOME.0 as i32).as_slice(), &le32(HOME.1 as i32), &[0u8]].concat();
    let settle = body(
        Kind::SETTLE,
        plog::NO_BELL,
        &settle_key,
        &pad(Kind::SETTLE, vec![0]),
        &mut [(EntityKind::Holding, &mut ho)],
    );
    b.tx(
        GENESIS_TS - 700,
        vec![join, settle],
        vec![
            (caddr, Some(ci)),
            (cx.holding(HOME.0 as i32, HOME.1 as i32, 0), Some(ho)),
        ],
        false,
    );
    let e0 = b.txs.len();

    // S1: OpenRing(2) lands; its seed waits for the beacon round.
    let d = GENESIS_RING as u16 + 1;
    put(
        &mut fr,
        L::world::frontier::RINGS_OPENED,
        &(d + 1).to_le_bytes(),
    );
    let open = body(
        Kind::RING_OPEN,
        plog::NO_BELL,
        &d.to_le_bytes(),
        &[0u8; 48],
        &mut [(EntityKind::Frontier, &mut fr)],
    );
    b.tx(
        GENESIS_TS + 600,
        vec![open],
        vec![
            (cx.ring_seed(d), Some(ring_seed_account(d, 1, [0; 32]))),
            (cx.frontier(), Some(fr.clone())),
        ],
        false,
    );
    let e1 = b.txs.len();

    // S2: ConsumeRingSeed(2) (chains nothing, log.rs W1-E), then two of
    // the ring's Provinces.
    let seed = ring_seed(d);
    let mut payload = vec![0u8; 8];
    payload.extend(seed);
    let consumed = body(
        Kind::RING_SEED,
        plog::NO_BELL,
        &d.to_le_bytes(),
        &payload,
        &mut [],
    );
    b.tx(
        GENESIS_TS + 660,
        vec![consumed],
        vec![(cx.ring_seed(d), Some(ring_seed_account(d, 2, seed)))],
        false,
    );
    open_provinces(&mut b, &RING2_OPENED);
    let e2 = b.txs.len();
    (b.txs, [e0, e1, e2])
}
