//! S1 stage 1d: watchtowers (`docs/frontier/stage1d/S1-1D-CONTRACT.md`)
//! on the test-beacon build: BuildStructure, SeizeStructure and CloseStructure (their
//! effects and refusals), and the wear a tower's coverage puts on what
//! walks through it — a march at Reveal (`WORN_BPS`) landing at
//! GatherClash (the record and the transit, once; J4: a late arrival is
//! worn no more than an on-time one), a caravan at its send.
//!
//! Crafted state: the S1 casts are `world::conquest` estates (as the
//! caravan tests'); the march tests use `world::transit`'s trips, with a
//! tower entry written into a Province's list where a test needs one
//! standing (BuildStructure itself is tested through the program).

mod common;

use fclient::ix::v2::{self as fx, PlaceRef, SendCaravanArgs};
use fclient::ix::Player;
use frontier_abi::layout::clash::{arrival as AR, arrival_slot as AS, clash_inputs as CI};
use frontier_abi::layout::player::{holding as H, transit as T};
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{province as P, structure_entry as TE};
use frontier_abi::v2::layout::s1::{arrival as S1A, caravan as CV, structure as TW};
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
use permutation_rules::frontier::structure::{
    self as kt, march_watch, wear, wear_bps, Stances, StructureEntry, Walked, WatchedLand,
    KIND_FORT, KIND_PALISADE, KIND_TOWER,
};

const B0: u32 = 20;
/// A fresh season's stances: every nation at war with every other.
const WAR: Stances = [kt::STANCE_WAR; 36];
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

    fn build(&mut self, who: char, kind: u8, tile: u8, notify: u8) -> SendResult {
        let e = if who == 'a' { &self.a } else { &self.r };
        let ix = fx::build_structure(
            &self.w.a,
            &e.player(),
            e.href(),
            (e.p, e.q),
            kind,
            tile,
            notify,
        );
        let k = e.wallet.insecure_clone();
        s1_send(&mut self.c, I2::BuildStructure, ix, &[&k])
    }

    fn structure(&self, tile: u8) -> Address {
        self.w.a.structure(self.a.p as i32, self.a.q as i32, tile)
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

fn entry(c: &Chain, province: &Address, i: usize) -> StructureEntry {
    StructureEntry::decode(&c.data(province)[TE::at(i)..TE::at(i) + TE::SIZE]).unwrap()
}

/// Writes a live tower entry into a Province's list (a tower standing,
/// for the wear tests).
fn put_tower(c: &mut Chain, province: &Address, i: usize, tile: u8, faction: u8) {
    put_structure(c, province, i, KIND_TOWER, tile, faction);
}

/// Writes a live structure entry of `kind` into a Province's list.
fn put_structure(c: &mut Chain, province: &Address, i: usize, kind: u8, tile: u8, faction: u8) {
    c.edit(province, |d| {
        StructureEntry {
            kind,
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

// ------------------------------------------------------------ BuildStructure

#[test]
fn g13_s1_build_tower_lands_pays_and_lists() {
    let mut k = Cast::new();
    let before: Vec<i64> = (0..8)
        .map(|r| read_kholding(&k.c.data(&k.a.holding)).stores[r].value)
        .collect();
    let tt = k.tt;
    let l = expect_lands(
        k.build('a', KIND_TOWER, tt, TW::NOTIFY_FACTION),
        "BuildStructure",
    );
    let d = k.c.data(&k.structure(tt));
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
        StructureEntry {
            kind: KIND_TOWER,
            tile: tt,
            faction: 0,
            gen: 1
        }
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::TOWERS], 1);
    let cost = kt::cost(KIND_TOWER);
    for (r, b) in before.iter().enumerate() {
        let now = read_kholding(&k.c.data(&k.a.holding)).stores[r].value;
        assert!(
            now <= b - cost[r] + 10 * MILLI && now >= b - cost[r] - 10 * MILLI,
            "store {r}"
        );
    }
    match event(&l, CqKind::STRUCTURE_BUILT) {
        fclient::conquest::CqEvent::StructureBuilt {
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
    expect_lands(k.build('a', KIND_TOWER, t2, 0), "BuildStructure");
    assert_eq!(entry(&k.c, &k.a.province, 1).tile, t2);
}

#[test]
fn g13_s1_build_tower_refusals() {
    let mut k = Cast::new();
    let tt = k.tt;
    // A site, an impassable tile.
    let site = k.a.tile;
    assert_cq(k.build('a', KIND_TOWER, site, 0), Cq::StructureSite);
    let pq = (k.a.p, k.a.q);
    k.c.edit(&k.a.province, |d| {
        let m = u64_at(d, P::PASSABLE_MASK) & !(1u64 << tt);
        d[P::PASSABLE_MASK..P::PASSABLE_MASK + 8].copy_from_slice(&m.to_le_bytes());
    });
    assert_cq(k.build('a', KIND_TOWER, tt, 0), Cq::StructureSite);
    k.w.open_tiles(&mut k.c, pq.0, pq.1, &[tt]);
    // A bad notify setting.
    assert_code(k.build('a', KIND_TOWER, tt, 2), E::BadData);
    // The citizen's limit.
    k.c.edit(&k.a.citizen, |d| d[C::TOWERS] = kt::max_of(KIND_TOWER));
    assert_cq(k.build('a', KIND_TOWER, tt, 0), Cq::StructureLimit);
    k.c.edit(&k.a.citizen, |d| d[C::TOWERS] = 0);
    // A full list.
    let province = k.a.province;
    for i in 0..TE::N {
        put_tower(&mut k.c, &province, i, 60 - i as u8, 3);
    }
    assert_cq(k.build('a', KIND_TOWER, tt, 0), Cq::StructureFull);
    k.c.edit(&province, |d| d[TE::BLOCK].fill(0));
    // Not enough goods.
    k.w.edit_kholding(&mut k.c, &k.a, |h| {
        for s in h.stores.iter_mut() {
            s.value = 0;
        }
    });
    assert_code(k.build('a', KIND_TOWER, tt, 0), E::Insufficient);
    k.w.enrich(&mut k.c, &k.a, 5_000);
    expect_lands(k.build('a', KIND_TOWER, tt, 0), "BuildStructure");
    // One tower a tile.
    assert_cq(k.build('r', KIND_TOWER, tt, 0), Cq::StructureSite);
}

/// Stage 1e: a palisade and a fort are built as a tower is, each against
/// its own counter and limit; a fort also takes a record in the Province's
/// fort block (no troops, nothing pending).
#[test]
fn g13_s1_build_palisades_and_forts() {
    use frontier_abi::v2::layout::province::fort_record as FR;
    let mut k = Cast::new();
    let tt = k.tt;
    let t2 = far_tile(&k.c, &k.a, 2);
    let t3 = far_tile(&k.c, &k.a, 3);
    // A kind outside the table.
    assert_code(k.build('a', 0, tt, 0), E::BadData);
    assert_code(k.build('a', 4, tt, 0), E::BadData);
    let l = expect_lands(
        k.build('a', KIND_PALISADE, tt, 0),
        "BuildStructure palisade",
    );
    assert_eq!(k.c.data(&k.structure(tt))[TW::KIND], KIND_PALISADE);
    assert_eq!(entry(&k.c, &k.a.province, 0).kind, KIND_PALISADE);
    let cd = k.c.data(&k.a.citizen);
    assert_eq!((cd[C::TOWERS], cd[C::PALISADES], cd[C::FORTS]), (0, 1, 0));
    match event(&l, CqKind::STRUCTURE_BUILT) {
        fclient::conquest::CqEvent::StructureBuilt { kind, .. } => {
            assert_eq!(kind, KIND_PALISADE)
        }
        e => panic!("{e:?}"),
    }
    expect_lands(k.build('a', KIND_FORT, t2, 0), "BuildStructure fort");
    let pd = k.c.data(&k.a.province);
    assert_eq!(entry(&k.c, &k.a.province, 1).kind, KIND_FORT);
    let o = FR::at(0);
    assert_eq!(
        (
            pd[o + FR::TILE],
            pd[o + FR::FACTION],
            pd[o + FR::GEN],
            pd[o + FR::STATE]
        ),
        (t2, 0, 1, FR::STATE_LIVE)
    );
    assert_eq!(u32_at(&pd, o + FR::TROOPS), 0);
    assert_eq!(u32_at(&pd, o + FR::PEND_BELL), u32::MAX);
    assert_eq!(k.c.data(&k.a.citizen)[C::FORTS], 1);
    // One fort a citizen.
    assert_cq(k.build('a', KIND_FORT, t3, 0), Cq::StructureLimit);
    // Two forts a Province: R's second one finds the fort block full.
    let t4 = far_tile(&k.c, &k.a, 1);
    expect_lands(k.build('r', KIND_FORT, t3, 0), "BuildStructure R's fort");
    k.c.edit(&k.r.citizen, |d| d[C::FORTS] = 0);
    assert_cq(k.build('r', KIND_FORT, t4, 0), Cq::StructureFull);
    // The palisade limit.
    k.c.edit(&k.a.citizen, |d| {
        d[C::PALISADES] = kt::max_of(KIND_PALISADE)
    });
    assert_cq(k.build('a', KIND_PALISADE, t4, 0), Cq::StructureLimit);
    // Each kind pays its own cost.
    for kind in [KIND_TOWER, KIND_PALISADE, KIND_FORT] {
        assert_ne!(kt::cost(kind), [0; 8], "kind {kind}");
    }
}

// ------------------------------------------------------------ SeizeStructure

#[test]
fn g13_s1_seize_tower_by_standing_on_it() {
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', KIND_TOWER, tt, 0), "BuildStructure");
    let seize = |k: &mut Cast, entry: u8| {
        let ix = fx::seize_structure(
            &k.w.a,
            &k.r.player(),
            (k.a.p, k.a.q, tt),
            k.r.href(),
            k.a.citizen,
            entry,
        );
        let w = k.r.wallet.insecure_clone();
        s1_send(&mut k.c, I2::SeizeStructure, ix, &[&w])
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
    k.c.edit(&k.r.citizen, |d| d[C::TOWERS] = kt::max_of(KIND_TOWER));
    assert_cq(seize(&mut k, 0), Cq::StructureLimit);
    k.c.edit(&k.r.citizen, |d| d[C::TOWERS] = 0);
    let l = expect_lands(seize(&mut k, 0), "SeizeStructure");
    let d = k.c.data(&k.structure(tt));
    assert_eq!(
        &d[TW::OWNER_CITIZEN..TW::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref()
    );
    assert_eq!((d[TW::GEN], d[TW::FACTION]), (2, 1));
    assert_eq!(
        entry(&k.c, &province, 0),
        StructureEntry {
            kind: KIND_TOWER,
            tile: tt,
            faction: 1,
            gen: 2
        },
        "the list follows"
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::TOWERS], 0);
    assert_eq!(k.c.data(&k.r.citizen)[C::TOWERS], 1);
    match event(&l, CqKind::STRUCTURE_SEIZED) {
        fclient::conquest::CqEvent::StructureSeized {
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

/// Stage 1e: a fort is seized only once it has fallen (no troops, none
/// pending: `FortManned`); its record then follows the account's faction
/// and generation.
#[test]
fn g13_s1_seize_a_fort_once_it_has_fallen() {
    use frontier_abi::v2::layout::province::fort_record as FR;
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', KIND_FORT, tt, 0), "BuildStructure fort");
    let province = k.a.province;
    k.w.craft_host(&mut k.c, &k.r, &province, 0, 0, 0, 500, tt);
    let seize = |k: &mut Cast| {
        let ix = fx::seize_structure(
            &k.w.a,
            &k.r.player(),
            (k.a.p, k.a.q, tt),
            k.r.href(),
            k.a.citizen,
            0,
        );
        let w = k.r.wallet.insecure_clone();
        s1_send(&mut k.c, I2::SeizeStructure, ix, &[&w])
    };
    let o = FR::at(0);
    // Manned: troops standing, or troops on the way.
    k.c.edit(&province, |d| {
        d[o + FR::TROOPS..o + FR::TROOPS + 4].copy_from_slice(&1u32.to_le_bytes())
    });
    assert_cq(seize(&mut k), Cq::FortManned);
    k.c.edit(&province, |d| {
        d[o + FR::TROOPS..o + FR::TROOPS + 4].fill(0);
        d[o + FR::PEND..o + FR::PEND + 2].copy_from_slice(&3u16.to_le_bytes());
    });
    assert_cq(seize(&mut k), Cq::FortManned);
    k.c.edit(&province, |d| d[o + FR::PEND..o + FR::PEND + 2].fill(0));
    expect_lands(seize(&mut k), "SeizeStructure fort");
    let pd = k.c.data(&province);
    assert_eq!(
        (
            pd[o + FR::TILE],
            pd[o + FR::FACTION],
            pd[o + FR::GEN],
            pd[o + FR::STATE]
        ),
        (tt, 1, 2, FR::STATE_LIVE)
    );
    assert_eq!(k.c.data(&k.a.citizen)[C::FORTS], 0);
    assert_eq!(k.c.data(&k.r.citizen)[C::FORTS], 1);
    assert_eq!(entry(&k.c, &province, 0).faction, 1);
    // Closing it clears the record.
    let rent_to = k.c.data(&k.structure(tt));
    let rent_to =
        Address::new_from_array(rent_to[TW::RENT_TO..TW::RENT_TO + 32].try_into().unwrap());
    let ix = fx::close_structure(&k.w.a, &k.r.player(), (k.a.p, k.a.q, tt), rent_to);
    let rw = k.r.wallet.insecure_clone();
    expect_lands(
        s1_send(&mut k.c, I2::CloseStructure, ix, &[&rw]),
        "CloseStructure fort",
    );
    assert_eq!(k.c.data(&province)[o + FR::STATE], FR::STATE_NONE);
    assert_eq!(k.c.data(&k.r.citizen)[C::FORTS], 0);
}

// ------------------------------------------------------------ CloseStructure

#[test]
fn g13_s1_close_tower() {
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', KIND_TOWER, tt, 0), "BuildStructure");
    let rent_to = k.a.wallet.pubkey();
    let close = |k: &mut Cast, p: Player, s: &Keypair| {
        let ix = fx::close_structure(&k.w.a, &p, (k.a.p, k.a.q, tt), rent_to);
        s1_send(&mut k.c, I2::CloseStructure, ix, &[s])
    };
    let session = session_of(&mut k.c, &k.a, b"s1-tower-session");
    let sp = Player {
        actor: session.pubkey(),
        payer: session.pubkey(),
        wallet: k.a.wallet.pubkey(),
    };
    assert_cq(close(&mut k, sp, &session), Cq::WalletRequired);
    let ix = fx::close_structure(&k.w.a, &k.r.player(), (k.a.p, k.a.q, tt), rent_to);
    let rw = k.r.wallet.insecure_clone();
    assert_code(
        s1_send(&mut k.c, I2::CloseStructure, ix, &[&rw]),
        E::NotOwner,
    );
    let before = k.c.lamports(&rent_to);
    let rent = k.c.lamports(&k.structure(tt));
    let w = k.a.wallet.insecure_clone();
    let owner = k.a.player();
    let l = expect_lands(close(&mut k, owner, &w), "CloseStructure");
    assert!(k.c.is_absent(&k.structure(tt)));
    assert_eq!(k.c.lamports(&rent_to) + l.fee, before + rent);
    assert_eq!(k.c.data(&k.a.citizen)[C::TOWERS], 0);
    assert!(
        !entry(&k.c, &k.a.province, 0).live(),
        "the entry is cleared"
    );
    match event(&l, CqKind::STRUCTURE_CLOSED) {
        fclient::conquest::CqEvent::StructureClosed { tile, entry, .. } => {
            assert_eq!((tile, entry), (tt, 0))
        }
        e => panic!("{e:?}"),
    }
    // The tile is free again.
    expect_lands(k.build('a', KIND_TOWER, tt, 0), "BuildStructure again");
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
                watch: kt::watch(&d[TE::BLOCK], &WAR, t.faction(), false),
            }
        })
        .collect();
    let s = march_watch(
        (ProvinceCoord::new(t.e.p as i32, t.e.q as i32), t.e.tile),
        &t.m.plain.path,
        t.m.plain.path_len,
        &lands,
        false,
    )
    .expect("the walk's provinces");
    match s {
        Walked::Secs(s) => wear_bps(s),
        Walked::Blocked => panic!("blocked"),
    }
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
    expect_lands(k.build('r', KIND_TOWER, tt, 0), "BuildStructure");
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
    let watch = kt::watch(&pd[TE::BLOCK], &WAR, 0, false);
    let Walked::Secs(secs) = kt::caravan_watch(&walked, |_| watch) else {
        panic!("blocked")
    };
    let want = wear_bps(secs);
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

// ------------------------------------------------------------ the stop rule (1e)

/// Writes the Season's stance of `nation` toward `faction`.
fn set_stance(c: &mut Chain, w: &World, nation: u8, faction: u8, stance: u8) {
    use frontier_abi::v2::layout::world::season as S2;
    c.edit(&w.a.season, |d| {
        d[S2::STANCES + nation as usize * 6 + faction as usize] = stance
    });
}

/// Stage 1e: a palisade on the march's way stops a walker it stops (a
/// faction its nation is at war with: `Path` at Reveal); its own nation's
/// march passes, as does one its nation lets pass (PASS, and ALLY alike);
/// an expelled owner's march is stopped by its own nation's works, and a
/// tower of a nation at PASS wears nothing.
#[test]
fn g13_s1_a_palisade_stops_whom_its_nation_stops() {
    let (mut c, w) = march_world();
    let t = w.trip(
        &mut c,
        "pal",
        0,
        (2, 0),
        0,
        TROOPS,
        &EAST8,
        6,
        SealCase::Valid,
    );
    let dest = w.a.province(t.dest().0, t.dest().1);
    // Its own nation's palisade: passes.
    put_structure(&mut c, &dest, 0, KIND_PALISADE, t.m.dest_tile, 0);
    expect_lands(
        w.trip_reveal(&mut c.fork(), &t, 0),
        "Reveal past an own palisade",
    );
    // Expelled: its own nation's works stop it.
    {
        let mut f = c.fork();
        f.edit(&t.e.holding, |d| {
            d[H::FLAGS] |= frontier_abi::v2::layout::player::holding::FLAG_EXPELLED
        });
        assert_code(w.trip_reveal(&mut f, &t, 0), E::Path);
    }
    // A hostile one (nation 3, at war with all): Path.
    put_structure(&mut c, &dest, 0, KIND_PALISADE, t.m.dest_tile, 3);
    assert_code(w.trip_reveal(&mut c.fork(), &t, 0), E::Path);
    // Nation 3 lets faction 0 pass (or allies with it): lands.
    for stance in [kt::STANCE_PASS, kt::STANCE_ALLY] {
        let mut f = c.fork();
        set_stance(&mut f, &w, 3, 0, stance);
        expect_lands(
            w.trip_reveal(&mut f, &t, 0),
            "Reveal past a passing palisade",
        );
        assert_eq!(slot_worn(&f, &w, &t, 0), 0);
    }
    // The stance is one-sided: faction 0 letting nation 3 pass changes
    // nothing for faction 0's march.
    let mut f = c.fork();
    set_stance(&mut f, &w, 0, 3, kt::STANCE_PASS);
    assert_code(w.trip_reveal(&mut f, &t, 0), E::Path);
    // A tower of a nation at PASS wears nothing; at WAR it wears.
    put_structure(&mut c, &dest, 0, KIND_TOWER, t.m.dest_tile, 3);
    let mut f = c.fork();
    set_stance(&mut f, &w, 3, 0, kt::STANCE_PASS);
    expect_lands(w.trip_reveal(&mut f, &t, 0), "Reveal past a passing tower");
    assert_eq!(slot_worn(&f, &w, &t, 0), 0);
    expect_lands(w.trip_reveal(&mut c, &t, 0), "Reveal past a hostile tower");
    assert!(slot_worn(&c, &w, &t, 0) > 0);
}

/// Stage 1e: a fort neither wears nor stops a march at Reveal (it fights
/// at the clash, 1e-5).
#[test]
fn g13_s1_a_fort_does_not_stop_a_march() {
    let (mut c, w) = march_world();
    let t = w.trip(
        &mut c,
        "fort",
        0,
        (2, 0),
        0,
        TROOPS,
        &EAST8,
        6,
        SealCase::Valid,
    );
    let dest = w.a.province(t.dest().0, t.dest().1);
    put_structure(&mut c, &dest, 0, KIND_FORT, t.m.dest_tile, 3);
    expect_lands(w.trip_reveal(&mut c, &t, 0), "Reveal past a fort");
    assert_eq!(slot_worn(&c, &w, &t, 0), 0);
}

/// Stage 1e: a caravan's route through a palisade that stops it is
/// refused (`Path`); its own nation's palisade lets it through.
#[test]
fn g13_s1_a_palisade_stops_a_caravan() {
    let mut k = Cast::new();
    let tt = k.tt;
    let ix = fx::build_vault(&k.w.a, &k.a.player(), k.a.href(), (k.a.p, k.a.q), tt);
    let aw = k.a.wallet.insecure_clone();
    expect_lands(s1_send(&mut k.c, I2::BuildVault, ix, &[&aw]), "BuildVault");
    let dirs = local_dirs(&k.c, &k.a, k.a.tile, tt).unwrap();
    let path = kc::pack(&dirs).unwrap();
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
        cargo: [0, 100, 0, 0, 0, 50, 0, 0],
        fee: CARAVAN_FEE,
        provinces: vec![(k.a.p, k.a.q)],
    };
    let province = k.a.province;
    put_structure(&mut k.c, &province, 0, KIND_PALISADE, tt, 1);
    let ix = fx::send_caravan(&k.w.a, &k.a.player(), &x);
    assert_code(
        s1_send(&mut k.c.fork(), I2::SendCaravan, ix.clone(), &[&aw]),
        E::Path,
    );
    // R's nation lets A's faction pass.
    let mut f = k.c.fork();
    set_stance(&mut f, &k.w, 1, 0, kt::STANCE_PASS);
    expect_lands(
        s1_send(&mut f, I2::SendCaravan, ix, &[&aw]),
        "SendCaravan past",
    );
    put_structure(&mut k.c, &province, 0, KIND_PALISADE, tt, 0);
    let ix = fx::send_caravan(&k.w.a, &k.a.player(), &x);
    expect_lands(
        s1_send(&mut k.c, I2::SendCaravan, ix, &[&aw]),
        "SendCaravan past an own palisade",
    );
}

// ------------------------------------------------------------ forts (1e step 5)

/// The fort record of `tile` in the cast's Province: `(troops milli,
/// pend_bell, pend)`.
fn fort_troops(c: &Chain, province: &Address, tile: u8) -> (u32, u32, u16) {
    use frontier_abi::v2::layout::province::fort_record as FR;
    let d = c.data(province);
    let i = (0..FR::N)
        .find(|&i| d[FR::at(i) + FR::STATE] == FR::STATE_LIVE && d[FR::at(i) + FR::TILE] == tile)
        .expect("a live fort");
    let o = FR::at(i);
    (
        u32_at(&d, o + FR::TROOPS),
        u32_at(&d, o + FR::PEND_BELL),
        u16::from_le_bytes([d[o + FR::PEND], d[o + FR::PEND + 1]]),
    )
}

fn set_reserve(c: &mut Chain, holding: &Address, spearmen: u32) {
    use frontier_abi::v2::layout::player::holding as H2;
    c.edit(holding, |d| {
        d[H2::reserve(0)..H2::reserve(0) + 4].copy_from_slice(&spearmen.to_le_bytes())
    });
}

fn fort_garrison(k: &mut Cast, who: char, tile: u8, troops: u32) -> SendResult {
    let e = if who == 'a' { &k.a } else { &k.r };
    let ix = fx::fort_garrison(&k.w.a, &e.player(), e.href(), tile, troops);
    let w = e.wallet.insecure_clone();
    s1_send(&mut k.c, I2::FortGarrison, ix, &[&w])
}

/// FortGarrison: the owner's Spearmen join the fort from the next bell
/// (a due pending part folded first), up to `FORT_MAX_TROOPS`.
#[test]
fn g13_s1_fort_garrison_and_refusals() {
    use frontier_abi::v2::layout::player::holding as H2;
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', KIND_FORT, tt, 0), "BuildStructure fort");
    let province = k.a.province;
    let b = k.w.bell_at(k.c.now).unwrap();
    k.w.set_resolved_next(&mut k.c, &province, b);
    set_reserve(&mut k.c, &k.a.holding, 500);
    let l = expect_lands(fort_garrison(&mut k, 'a', tt, 300), "FortGarrison");
    let row = frontier_abi::v2::budgets::budget(I2::FortGarrison).cu_limit as u64;
    println!("FortGarrison: {} CU (row {row})", l.cu);
    assert!(l.cu <= row);
    assert_eq!(fort_troops(&k.c, &province, tt), (0, b + 1, 300));
    assert_eq!(u32_at(&k.c.data(&k.a.holding), H2::reserve(0)), 200);
    match event(&l, CqKind::FORT_GARRISONED) {
        fclient::conquest::CqEvent::FortGarrisoned {
            tile,
            owner_tag,
            troops,
            pend_bell,
            pend,
            holding_key,
            ..
        } => assert_eq!(
            (tile, owner_tag, troops, pend_bell, pend, holding_key),
            (tt, k.a.citizen_tag(), 300, b + 1, 300, k.a.host_id(0))
        ),
        e => panic!("{e:?}"),
    }
    // Refusals: no troops, more than the reserve, past the cap.
    assert_code(fort_garrison(&mut k, 'a', tt, 0), E::BadData);
    assert_code(fort_garrison(&mut k, 'a', tt, 201), E::Insufficient);
    assert_code(
        fort_garrison(&mut k, 'a', tt, kt::FORT_MAX_TROOPS + 1),
        E::BadData,
    );
    set_reserve(&mut k.c, &k.a.holding, 5_000);
    assert_cq(
        fort_garrison(&mut k, 'a', tt, kt::FORT_MAX_TROOPS - 299),
        Cq::StructureLimit,
    );
    // Another village's holding, a tower, an unresolved Province.
    set_reserve(&mut k.c, &k.r.holding, 500);
    assert_code(fort_garrison(&mut k, 'r', tt, 10), E::NotOwner);
    let t2 = far_tile(&k.c, &k.a, 2);
    expect_lands(k.build('a', KIND_TOWER, t2, 0), "BuildStructure tower");
    assert_code(fort_garrison(&mut k, 'a', t2, 10), E::BadData);
    let mut f = k.c.fork();
    k.w.set_resolved_next(&mut f, &province, b.saturating_sub(5));
    let ix = fx::fort_garrison(&k.w.a, &k.a.player(), k.a.href(), tt, 10);
    let aw = k.a.wallet.insecure_clone();
    assert_code(
        s1_send(&mut f, I2::FortGarrison, ix, &[&aw]),
        E::NotResident,
    );
    // Once due, the pending part folds into the troops.
    k.w.to_bell(&mut k.c, b + 2, 5);
    k.w.set_resolved_next(&mut k.c, &province, b + 2);
    expect_lands(fort_garrison(&mut k, 'a', tt, 50), "FortGarrison again");
    assert_eq!(fort_troops(&k.c, &province, tt), (300_000, b + 3, 50));
}

/// Resolves bell `b` of the cast's Province through the program's own
/// clash (SkipQuiet refused as not quiet, GatherClash, ResolveFromInputs).
fn clash_here(k: &mut Cast, b: u32) {
    let dest = (k.a.p as i32, k.a.q as i32);
    let region = k.c.data(&k.a.province)[P::REGION];
    k.w.set_resolved_next(&mut k.c, &k.a.province, b);
    k.w.ready_bell(&mut k.c, b, region, None);
    let ix = k.w.skip_ix(dest, b, 1);
    assert_code(k.c.send(&[ix], &[&k.w.keeper]), E::NotQuiet);
    let ix = k.w.gather_ix(&k.c, dest, b, 0, 1);
    expect_lands(k.c.send(&[ix], &[&k.w.keeper]), "GatherClash");
    let ix = k.w.resolve_ix(dest, b);
    expect_lands(k.c.send(&[ix], &[&k.w.keeper]), "ResolveFromInputs");
}

/// A manned fort fights a host of another faction on its tile as a walled
/// garrison of its faction (its due pending troops folded in); beaten, it
/// has fallen (0 troops) and the victor seizes it. A fort with only its
/// own faction on its tile leaves the bell quiet.
#[test]
fn g13_s1_a_fort_fights_falls_and_is_seized() {
    use frontier_abi::v2::layout::province::fort_record as FR;
    let mut k = Cast::new();
    let tt = k.tt;
    expect_lands(k.build('a', KIND_FORT, tt, 0), "BuildStructure fort");
    let province = k.a.province;
    let b = k.w.bell_at(k.c.now).unwrap() + 1;
    // 40 troops standing and 20 pending, due at `b`.
    k.c.edit(&province, |d| {
        let o = FR::at(0);
        d[o + FR::TROOPS..o + FR::TROOPS + 4].copy_from_slice(&40_000u32.to_le_bytes());
        d[o + FR::PEND_BELL..o + FR::PEND_BELL + 4].copy_from_slice(&b.to_le_bytes());
        d[o + FR::PEND..o + FR::PEND + 2].copy_from_slice(&20u16.to_le_bytes());
    });
    // Its own faction's host on its tile: quiet.
    {
        let mut f = k.c.fork();
        k.w.craft_host(&mut f, &k.a, &province, 1, 0, 0, 100, tt);
        let dest = (k.a.p as i32, k.a.q as i32);
        let region = f.data(&province)[P::REGION];
        k.w.set_resolved_next(&mut f, &province, b);
        k.w.ready_bell(&mut f, b, region, None);
        expect_lands(
            f.send(&[k.w.skip_ix(dest, b, 1)], &[&k.w.keeper]),
            "SkipQuiet",
        );
    }
    // R's host of 2,000 on the fort's tile beats it.
    k.w.craft_host(&mut k.c, &k.r, &province, 0, 0, 0, 2_000, tt);
    clash_here(&mut k, b);
    let (troops, pend_bell, pend) = fort_troops(&k.c, &province, tt);
    assert_eq!(
        (troops, pend_bell, pend),
        (0, u32::MAX, 0),
        "fallen, the pending part folded"
    );
    // R seizes the fallen fort.
    let ix = fx::seize_structure(
        &k.w.a,
        &k.r.player(),
        (k.a.p, k.a.q, tt),
        k.r.href(),
        k.a.citizen,
        0,
    );
    let rw = k.r.wallet.insecure_clone();
    k.w.set_resolved_next(&mut k.c, &province, b + 1);
    expect_lands(
        s1_send(&mut k.c, I2::SeizeStructure, ix, &[&rw]),
        "SeizeStructure",
    );
    assert_eq!(k.c.data(&province)[FR::at(0) + FR::FACTION], 1);
}
