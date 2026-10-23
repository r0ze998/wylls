//! S1 stage 1d: watchtowers (`docs/frontier/stage1d/S1-1D-CONTRACT.md`)
//! on the test-beacon build: BuildTower, SeizeTower and CloseTower (their
//! effects and refusals), and the wear a tower's coverage puts on what
//! walks through it — a march at Reveal (`WORN_BPS`) landing at
//! GatherClash (the record and the transit, once; J4: a late arrival is
//! worn no more than an on-time one), a caravan at its send.
//!
//! Crafted state: the S1 casts are `world::conquest` estates (as the
//! caravan tests'); the march tests use `world::transit`'s trips, with a
//! tower entry written into a Province's list where a test needs one
//! standing (BuildTower itself is tested through the program).

mod common;

use fclient::ix::v2::{self as fx, PlaceRef, SendCaravanArgs};
use fclient::ix::Player;
use frontier_abi::layout::clash::{arrival as AR, arrival_slot as AS, clash_inputs as CI};
use frontier_abi::layout::player::{holding as H, transit as T};
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{province as P, tower_entry as TE};
use frontier_abi::v2::layout::s1::{arrival as S1A, caravan as CV, tower as TW};
use frontier_abi::v2::log::{AnyKind, CqKind};
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::fixtures::tlock::SealCase;
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{
    i64_at, read_kholding, trace, u32_at, u64_at, Estate,
};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::transit::{clone_estate, Trip, EAST8};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair, Signer};
use permutation_rules::frontier::caravan::{self as kc, Land, CARAVAN_FEE};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::tower::{
    self as kt, hostile, march_secs_in_range, wear, wear_bps, TowerEntry, WatchedLand, MAX_TOWERS,
};

const B0: u32 = 20;
const MILLI: i64 = 1_000;

// ------------------------------------------------------------ worlds

fn s1_world() -> (Chain, World) {
    let mut c = Chain::new(Build::TestBeacon);
    let w = World::running(&mut c, 1);
    w.cq_set_params(&mut c, &MC_LOCAL_7D.cq);
    w.to_bell(&mut c, B0, 5);
    (c, w)
}

fn s1_send(c: &mut Chain, kind: I2, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let (bytes, n) = frontier_abi::v2::budgets::loaded_accounts(kind);
    let loaded = permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), bytes, n)
        .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT);
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(loaded);
    c.send_with(&p, &[ix], signers)
}

/// A (faction 0) and R (faction 1) hold sites 0 and 1 of a ring-4
/// Province with every tile opened; `tt` is a non-site tile four steps from
/// A's holding.
struct Cast {
    c: Chain,
    w: World,
    a: Estate,
    r: Estate,
    tt: u8,
}

impl Cast {
    fn new() -> Cast {
        let (mut c, w) = s1_world();
        let t = provinces_of(4, Some(0))[0];
        let a = w.cq_estate(&mut c, "a", 0, t, 0);
        let r = w.cq_estate(&mut c, "r", 1, t, 1);
        w.open_tiles(&mut c, t.0, t.1, &(0..61).collect::<Vec<u8>>());
        w.enrich(&mut c, &a, 5_000);
        w.enrich(&mut c, &r, 5_000);
        let tt = far_tile(&c, &a, 4);
        Cast { c, w, a, r, tt }
    }

    fn build(&mut self, who: char, tile: u8, notify: u8) -> SendResult {
        let e = if who == 'a' { &self.a } else { &self.r };
        let ix = fx::build_tower(&self.w.a, &e.player(), e.href(), (e.p, e.q), tile, notify);
        let k = e.wallet.insecure_clone();
        s1_send(&mut self.c, I2::BuildTower, ix, &[&k])
    }

    fn tower(&self, tile: u8) -> Address {
        self.w.a.tower(self.a.p as i32, self.a.q as i32, tile)
    }
}

/// A non-site tile of the estate's Province `n` steps from its holding
/// (inside the Province).
fn far_tile(c: &Chain, e: &Estate, n: usize) -> u8 {
    let pd = c.data(&e.province);
    let sites = &pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize];
    (0..61u8)
        .find(|&t| !sites.contains(&t) && local_dirs(c, e, e.tile, t).is_some_and(|d| d.len() == n))
        .expect("a tile n steps away")
}

fn local_dirs(c: &Chain, e: &Estate, from: u8, to: u8) -> Option<Vec<u8>> {
    use std::collections::{HashMap, VecDeque};
    let pass = u64_at(&c.data(&e.province), P::PASSABLE_MASK);
    let (p, q) = (e.p as i32, e.q as i32);
    let mut prev: HashMap<u8, (u8, u8)> = HashMap::new();
    let mut queue = VecDeque::from([from]);
    prev.insert(from, (from, 9));
    while let Some(t) = queue.pop_front() {
        if t == to {
            let mut dirs = vec![];
            let mut x = t;
            while x != from {
                let (pr, d) = prev[&x];
                dirs.push(d);
                x = pr;
            }
            dirs.reverse();
            return Some(dirs);
        }
        for d in 0..6u8 {
            let s = trace((p, q, t), &[d])[0];
            if (s.p, s.q) != (p, q) || pass & (1u64 << s.tile) == 0 || prev.contains_key(&s.tile) {
                continue;
            }
            prev.insert(s.tile, (t, d));
            queue.push_back(s.tile);
        }
    }
    None
}

fn entry(c: &Chain, province: &Address, i: usize) -> TowerEntry {
    TowerEntry::decode(&c.data(province)[TE::at(i)..TE::at(i) + TE::SIZE]).unwrap()
}

/// Writes a live tower entry into a Province's list (a tower standing,
/// for the wear tests).
fn put_tower(c: &mut Chain, province: &Address, i: usize, tile: u8, faction: u8) {
    c.edit(province, |d| {
        TowerEntry {
            live: true,
            tile,
            faction,
            gen: 1,
        }
        .encode(&mut d[TE::at(i)..TE::at(i) + TE::SIZE])
        .unwrap();
    });
}

#[track_caller]
fn event(l: &Landed, k: CqKind) -> fclient::conquest::CqEvent {
    let _ = records::one_cq(&l.logs, k);
    let body = records::bodies(&l.logs)
        .into_iter()
        .find(|b| frontier_abi::v2::log::decode(b).is_ok_and(|r| r.kind == AnyKind::Cq(k)))
        .expect("the body");
    fclient::conquest::parse(&body)
        .expect("fclient parses it")
        .event
}

fn session_of(c: &mut Chain, e: &Estate, label: &[u8]) -> Keypair {
    let session = c.funded(label, 1);
    let exp = c.now + 3_600;
    c.edit(&e.citizen, |d| {
        d[C::SESSION..C::SESSION + 32].copy_from_slice(&session.pubkey().to_bytes());
        d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&exp.to_le_bytes());
    });
    session
}

// ------------------------------------------------------------ BuildTower

#[test]
fn g13_s1_build_tower_lands_pays_and_lists() {
    let mut k = Cast::new();
    let before: Vec<i64> = (0..8)
        .map(|r| read_kholding(&k.c.data(&k.a.holding)).stores[r].value)
        .collect();
    let tt = k.tt;
    let l = expect_lands(k.build('a', tt, TW::NOTIFY_FACTION), "BuildTower");
    let d = k.c.data(&k.tower(tt));
    assert_eq!(d[TW::STATE], TW::STATE_LIVE);
    assert_eq!((d[TW::GEN], d[TW::FACTION], d[TW::ENTRY]), (1, 0, 0));
    assert_eq!(d[TW::NOTIFY], TW::NOTIFY_FACTION);
    assert_eq!(u64_at(&d, TW::OWNER_TAG), k.a.citizen_tag());
    assert_eq!(u32_at(&d, TW::SEIZED_BELL), u32::MAX);
    assert_eq!(
        &d[TW::RENT_TO..TW::RENT_TO + 32],
        k.a.wallet.pubkey().as_ref()
    );
    assert_eq!(
        entry(&k.c, &k.a.province, 0),
        TowerEntry {
            live: true,
            tile: tt,
            faction: 0,
            gen: 1
        }
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::TOWERS], 1);
    let cost = kt::tower_cost();
    for (r, b) in before.iter().enumerate() {
        let now = read_kholding(&k.c.data(&k.a.holding)).stores[r].value;
        assert!(
            now <= b - cost[r] + 10 * MILLI && now >= b - cost[r] - 10 * MILLI,
            "store {r}"
        );
    }
    match event(&l, CqKind::TOWER_BUILT) {
        fclient::conquest::CqEvent::TowerBuilt {
            tile,
            owner_tag,
            gen,
            entry,
            notify,
            ..
        } => assert_eq!(
            (tile, owner_tag, gen, entry, notify),
            (tt, k.a.citizen_tag(), 1, 0, 1)
        ),
        e => panic!("{e:?}"),
    }
    // A second tower takes the next entry.
    let t2 = far_tile(&k.c, &k.a, 2);
    expect_lands(k.build('a', t2, 0), "BuildTower");
    assert_eq!(entry(&k.c, &k.a.province, 1).tile, t2);
}

#[test]
fn g13_s1_build_tower_refusals() {
    let mut k = Cast::new();
    let tt = k.tt;
    // A site, an impassable tile.
    let site = k.a.tile;
    assert_cq(k.build('a', site, 0), Cq::TowerSite);
    let pq = (k.a.p, k.a.q);
    k.c.edit(&k.a.province, |d| {
        let m = u64_at(d, P::PASSABLE_MASK) & !(1u64 << tt);
        d[P::PASSABLE_MASK..P::PASSABLE_MASK + 8].copy_from_slice(&m.to_le_bytes());
    });
    assert_cq(k.build('a', tt, 0), Cq::TowerSite);
    k.w.open_tiles(&mut k.c, pq.0, pq.1, &[tt]);
    // A bad notify setting.
    assert_code(k.build('a', tt, 2), E::BadData);
    // The citizen's limit.
    k.c.edit(&k.a.citizen, |d| d[C::TOWERS] = MAX_TOWERS);
    assert_cq(k.build('a', tt, 0), Cq::TowerLimit);
    k.c.edit(&k.a.citizen, |d| d[C::TOWERS] = 0);
    // A full list.
    let province = k.a.province;
    for i in 0..TE::N {
        put_tower(&mut k.c, &province, i, 60 - i as u8, 3);
    }
    assert_cq(k.build('a', tt, 0), Cq::TowerFull);
    k.c.edit(&province, |d| d[TE::BLOCK].fill(0));
    // Not enough goods.
    k.w.edit_kholding(&mut k.c, &k.a, |h| {
        for s in h.stores.iter_mut() {
            s.value = 0;
        }
    });
    assert_code(k.build('a', tt, 0), E::Insufficient);
    k.w.enrich(&mut k.c, &k.a, 5_000);
    expect_lands(k.build('a', tt, 0), "BuildTower");
    // One tower a tile.
    assert_cq(k.build('r', tt, 0), Cq::TowerSite);
}

// ------------------------------------------------------------ SeizeTower

#[test]
fn g13_s1_seize_tower_by_standing_on_it() {
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', tt, 0), "BuildTower");
    let seize = |k: &mut Cast, entry: u8| {
        let ix = fx::seize_tower(
            &k.w.a,
            &k.r.player(),
            (k.a.p, k.a.q, tt),
            k.r.href(),
            k.a.citizen,
            entry,
        );
        let w = k.r.wallet.insecure_clone();
        s1_send(&mut k.c, I2::SeizeTower, ix, &[&w])
    };
    assert_cq(seize(&mut k, 0), Cq::NotOnTile);
    let province = k.a.province;
    k.w.craft_host(&mut k.c, &k.r, &province, 0, 0, 0, 500, tt);
    k.w.craft_host(&mut k.c, &k.a, &province, 1, 0, 0, 500, tt);
    assert_cq(seize(&mut k, 0), Cq::NotOnTile);
    k.c.edit(&province, |d| {
        let o = P::entry(1);
        d[o..o + frontier_abi::layout::province::entry::SIZE].fill(0);
        d[P::N_ENTRIES] -= 1;
    });
    k.c.edit(&k.r.citizen, |d| d[C::TOWERS] = MAX_TOWERS);
    assert_cq(seize(&mut k, 0), Cq::TowerLimit);
    k.c.edit(&k.r.citizen, |d| d[C::TOWERS] = 0);
    let l = expect_lands(seize(&mut k, 0), "SeizeTower");
    let d = k.c.data(&k.tower(tt));
    assert_eq!(
        &d[TW::OWNER_CITIZEN..TW::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref()
    );
    assert_eq!((d[TW::GEN], d[TW::FACTION]), (2, 1));
    assert_eq!(
        entry(&k.c, &province, 0),
        TowerEntry {
            live: true,
            tile: tt,
            faction: 1,
            gen: 2
        },
        "the list follows"
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::TOWERS], 0);
    assert_eq!(k.c.data(&k.r.citizen)[C::TOWERS], 1);
    match event(&l, CqKind::TOWER_SEIZED) {
        fclient::conquest::CqEvent::TowerSeized {
            captor_tag,
            prev_tag,
            new_gen,
            faction,
            domestic,
            ..
        } => assert_eq!(
            (captor_tag, prev_tag, new_gen, faction, domestic),
            (k.r.citizen_tag(), k.a.citizen_tag(), 2, 1, false)
        ),
        e => panic!("{e:?}"),
    }
}

// ------------------------------------------------------------ CloseTower

#[test]
fn g13_s1_close_tower() {
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', tt, 0), "BuildTower");
    let rent_to = k.a.wallet.pubkey();
    let close = |k: &mut Cast, p: Player, s: &Keypair| {
        let ix = fx::close_tower(&k.w.a, &p, (k.a.p, k.a.q, tt), rent_to);
        s1_send(&mut k.c, I2::CloseTower, ix, &[s])
    };
    let session = session_of(&mut k.c, &k.a, b"s1-tower-session");
    let sp = Player {
        actor: session.pubkey(),
        payer: session.pubkey(),
        wallet: k.a.wallet.pubkey(),
    };
    assert_cq(close(&mut k, sp, &session), Cq::WalletRequired);
    let ix = fx::close_tower(&k.w.a, &k.r.player(), (k.a.p, k.a.q, tt), rent_to);
    let rw = k.r.wallet.insecure_clone();
    assert_code(s1_send(&mut k.c, I2::CloseTower, ix, &[&rw]), E::NotOwner);
    let before = k.c.lamports(&rent_to);
    let rent = k.c.lamports(&k.tower(tt));
    let w = k.a.wallet.insecure_clone();
    let owner = k.a.player();
    let l = expect_lands(close(&mut k, owner, &w), "CloseTower");
    assert!(k.c.is_absent(&k.tower(tt)));
    assert_eq!(k.c.lamports(&rent_to) + l.fee, before + rent);
    assert_eq!(k.c.data(&k.a.citizen)[C::TOWERS], 0);
    assert!(!entry(&k.c, &k.a.province, 0).live, "the entry is cleared");
    match event(&l, CqKind::TOWER_CLOSED) {
        fclient::conquest::CqEvent::TowerClosed { tile, entry, .. } => {
            assert_eq!((tile, entry), (tt, 0))
        }
        e => panic!("{e:?}"),
    }
    // The tile is free again.
    expect_lands(k.build('a', tt, 0), "BuildTower again");
}

// ------------------------------------------------------------ marches

const TROOPS: u32 = 900;

fn march_world() -> (Chain, World) {
    let (mut c, w) = common::test_beacon();
    w.to_bell(&mut c, 10, 5);
    (c, w)
}

/// The kernel's wear of `t`'s walk against the towers standing now.
fn expected_wear(c: &Chain, w: &World, t: &Trip) -> u16 {
    let mut pqs = vec![t.dest()];
    pqs.extend(t.m.path.iter().copied());
    let lands: Vec<WatchedLand> = pqs
        .iter()
        .map(|&(p, q)| {
            let d = c.data(&w.a.province(p, q));
            WatchedLand {
                at: ProvinceCoord::new(p, q),
                rough: u64_at(&d, P::ROUGH_MASK),
                road: u64_at(&d, P::ROAD_MASK),
                cover: hostile(&d[TE::BLOCK], t.faction()),
            }
        })
        .collect();
    let s = march_secs_in_range(
        (ProvinceCoord::new(t.e.p as i32, t.e.q as i32), t.e.tile),
        &t.m.plain.path,
        t.m.plain.path_len,
        &lands,
        false,
    )
    .expect("the walk's provinces");
    wear_bps(s)
}

fn slot_worn(c: &Chain, w: &World, t: &Trip, i: u8) -> u16 {
    let d = c.data(&w.a.arrival_slot(t.dest().0, t.dest().1, t.arrive(), t.faction(), i));
    u16::from_le_bytes([d[S1A::WORN_BPS], d[S1A::WORN_BPS + 1]])
}

/// Reveal through a hostile tower's range writes the kernel's wear; a
/// friendly tower wears nothing; GatherClash lands the wear in the record
/// and in the transit, once.
#[test]
fn g13_s1_reveal_and_gather_wear_a_march_in_range() {
    let (mut c, w) = march_world();
    let t = w.trip(
        &mut c,
        "m",
        0,
        (2, 0),
        0,
        TROOPS,
        &EAST8,
        6,
        SealCase::Valid,
    );
    let dest = w.a.province(t.dest().0, t.dest().1);
    // A friendly tower on the destination: nothing.
    put_tower(&mut c, &dest, 0, t.m.dest_tile, 0);
    let mut f = c.fork();
    expect_lands(w.trip_reveal(&mut f, &t, 0), "Reveal");
    assert_eq!(slot_worn(&f, &w, &t, 0), 0, "a friendly tower");
    // A hostile one: worn by the kernel's seconds in range.
    put_tower(&mut c, &dest, 1, t.m.dest_tile, 3);
    let want = expected_wear(&c, &w, &t);
    assert!(want > 0, "the march ends in range");
    let l = expect_lands(w.trip_reveal(&mut c, &t, 0), "Reveal");
    assert_eq!(slot_worn(&c, &w, &t, 0), want);
    assert!(
        l.cu < 26_000,
        "Reveal within the MC preset's limit: {}",
        l.cu
    );
    // GatherClash.
    let region = World::region(t.dest().0, t.dest().1);
    w.ready_bell(&mut c, t.arrive(), region, None);
    let g = w.gather_ix(&c, t.dest(), t.arrive(), 0, 1);
    expect_lands(c.send(&[g.clone()], &[&w.keeper]), "GatherClash");
    let worn = wear(TROOPS as u64 * 1_000, want) as u32;
    let ci = c.data(&w.a.clash_inputs(t.dest().0, t.dest().1, t.arrive()));
    let o = CI::ARRIVALS;
    assert_eq!(u32_at(&ci, o + AR::TROOPS), worn, "the record is worn");
    let hd = c.data(&t.e.holding);
    let tr = H::transit(t.m.transit_slot as usize);
    assert_eq!(u32_at(&hd, tr + T::TROOPS_AFTER), worn, "so is the transit");
    // A second gather of the position does not wear again.
    if c.send(&[g], &[&w.keeper]).is_ok() {
        let ci = c.data(&w.a.clash_inputs(t.dest().0, t.dest().1, t.arrive()));
        assert_eq!(u32_at(&ci, o + AR::TROOPS), worn);
        assert_eq!(u32_at(&c.data(&t.e.holding), tr + T::TROOPS_AFTER), worn);
    }
    let _ = AS::SIZE;
}

/// J4: the wear is the walk's; a march that arrives later (waiting off
/// the road) is worn exactly as an on-time one on the same path.
#[test]
fn g13_s1_a_late_arrival_is_not_worn_while_it_waits() {
    let (mut c, w) = march_world();
    let early = w.trip(
        &mut c,
        "j4a",
        0,
        (2, 0),
        0,
        TROOPS,
        &EAST8,
        6,
        SealCase::Valid,
    );
    let late = w.trip_from(
        &mut c,
        clone_estate(&early.e),
        1,
        TROOPS,
        &EAST8,
        14,
        SealCase::Valid,
    );
    assert!(late.arrive() > early.arrive() + 4);
    let dest = w.a.province(early.dest().0, early.dest().1);
    put_tower(&mut c, &dest, 0, early.m.dest_tile, 2);
    expect_lands(w.trip_reveal(&mut c, &early, 0), "Reveal early");
    expect_lands(w.trip_reveal(&mut c, &late, 0), "Reveal late");
    let a = slot_worn(&c, &w, &early, 0);
    assert!(a > 0);
    assert_eq!(slot_worn(&c, &w, &late, 0), a);
}

// ------------------------------------------------------------ caravans

/// A caravan sent through a hostile tower's range carries the worn cargo
/// (the source paid the whole) and logs the wear and its path; the wear is
/// the kernel's (`caravan_secs_in_range` over the walk).
#[test]
fn g13_s1_a_caravan_is_worn_by_a_tower_on_its_route() {
    let mut k = Cast::new();
    let tt = k.tt;
    // A builds a vault at `tt`; R a tower on the same tile.
    let ix = fx::build_vault(&k.w.a, &k.a.player(), k.a.href(), (k.a.p, k.a.q), tt);
    let aw = k.a.wallet.insecure_clone();
    expect_lands(s1_send(&mut k.c, I2::BuildVault, ix, &[&aw]), "BuildVault");
    expect_lands(k.build('r', tt, 0), "BuildTower");
    let dirs = local_dirs(&k.c, &k.a, k.a.tile, tt).unwrap();
    let path = kc::pack(&dirs).unwrap();
    let cargo = [0, 100, 0, 0, 0, 50, 0, 0];
    let x = SendCaravanArgs {
        seq: 0,
        src: PlaceRef::Holding {
            h: k.a.href(),
            gen: k.a.gen,
        },
        dst: PlaceRef::Vault {
            p: k.a.p,
            q: k.a.q,
            tile: tt,
            gen: 1,
        },
        steps: dirs.len() as u8,
        path,
        cargo,
        fee: CARAVAN_FEE,
        provinces: vec![(k.a.p, k.a.q)],
    };
    let pd = k.c.data(&k.a.province);
    let at = ProvinceCoord::new(k.a.p as i32, k.a.q as i32);
    let land = Land {
        at,
        passable: u64_at(&pd, P::PASSABLE_MASK),
        rough: u64_at(&pd, P::ROUGH_MASK),
        road: u64_at(&pd, P::ROAD_MASK),
    };
    let walked = kc::walk(
        (at, k.a.tile),
        &path,
        dirs.len() as u8,
        &[land],
        of_faction_v3(0).unwrap().caravan_time_bps,
    )
    .unwrap();
    let cover = hostile(&pd[TE::BLOCK], 0);
    let want = wear_bps(kt::caravan_secs_in_range(&walked, |_| cover));
    assert!(want > 0);
    let ix = fx::send_caravan(&k.w.a, &k.a.player(), &x);
    let l = expect_lands(
        s1_send(&mut k.c, I2::SendCaravan, ix, &[&aw]),
        "SendCaravan",
    );
    let cv = k.c.data(&k.w.a.caravan(k.a.citizen_tag(), 0));
    for (r, u) in cargo.iter().enumerate() {
        let full = *u as i64 * MILLI;
        assert_eq!(
            i64_at(&cv, CV::cargo(r)),
            kt::wear_i64(full, want),
            "cargo {r}"
        );
    }
    match event(&l, CqKind::CARAVAN_SENT) {
        fclient::conquest::CqEvent::CaravanSent {
            worn_bps,
            path: p,
            cargo: logged,
            ..
        } => {
            assert_eq!((worn_bps, p), (want, path));
            assert_eq!(logged[1] as i64, kt::wear_i64(100 * MILLI, want) / MILLI);
        }
        e => panic!("{e:?}"),
    }
}
