//! S1 stage 1c: caravans in the shared clash model (`clash_model`, module
//! note "S1 caravans"; `S1-1B-CONTRACT.md` §3.5). A caravan standing in the
//! Province at a bell's start joins the clash as a 0-troop garrison of its
//! faction; a hostile host holding its tile raids it, an escort that holds
//! the tile keeps it safe; a caravan on a garrison's tile is sheltered; the
//! quiet test and the digests see the slots.

use frontier_abi::clash_model::{self as cm, TERRAINS};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::province::entry as E;
use frontier_abi::v2::layout::province::{caravan_slot as CS, province as P, site as SM};
use frontier_abi::v2::layout::{write_header, AccountKind};
use permutation_rules::frontier::caravan::{caravan_id, CaravanSlot, RAID_NONE, SLOT_TILES};
use permutation_rules::frontier::clash::{frontier_ruleset, resolve_clash};
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::terrain::{generate_province, ProvinceTerrain};

const B: u32 = 10;

/// A ring-4 Province v2 with no holdings, no camp due, no keep.
fn province() -> (Vec<u8>, ProvinceTerrain) {
    let c = ProvinceCoord::new(4, 0);
    let t = generate_province(&[7u8; 32], c);
    let mut pd = vec![0u8; P::SIZE];
    assert!(write_header(&mut pd, AccountKind::Province, 1));
    pd[P::P..P::P + 2].copy_from_slice(&4i16.to_le_bytes());
    pd[P::RING..P::RING + 2].copy_from_slice(&(c.ring() as u16).to_le_bytes());
    pd[P::WEDGE] = c.wedge().unwrap();
    for i in 0..61 {
        pd[P::TERRAIN + i] = TERRAINS.iter().position(|x| *x == t.terrain[i]).unwrap() as u8;
        pd[P::RESOURCE + i] = match t.resource[i] {
            None => 0,
            Some(r) => 1 + cm::RESOURCES.iter().position(|x| *x == r).unwrap() as u8,
        };
    }
    pd[P::SITES..P::SITES + 12].copy_from_slice(&t.sites);
    pd[P::SITE_COUNT] = t.site_count;
    for s in 0..12 {
        let o = P::site(s);
        pd[o + SM::PEND0_BELL..o + SM::PEND0_BELL + 4].copy_from_slice(&SM::NO_BELL.to_le_bytes());
        pd[o + SM::PEND1_BELL..o + SM::PEND1_BELL + 4].copy_from_slice(&SM::NO_BELL.to_le_bytes());
    }
    cm::Camp {
        tile: 0,
        state: 0,
        troops: 0,
        next_check_day: 1_000,
        gen: 0,
    }
    .write(&mut pd)
    .unwrap();
    frontier_abi::conquest_model::write_no_keep(&mut pd).unwrap();
    pd[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&B.to_le_bytes());
    (pd, t)
}

/// A passable tile that is not a site.
fn open_tile(t: &ProvinceTerrain, skip: usize) -> u8 {
    (0..61u8)
        .filter(|&i| t.passable(i) && !t.is_site(i))
        .nth(skip)
        .expect("an open tile")
}

fn host(pd: &mut [u8], i: usize, id: u64, faction: u8, tile: u8, troops: u32) {
    let e = Entry {
        id,
        faction,
        unit: 0,
        tile,
        state: E::STATE_ROSTER,
        troops: troops * 1_000,
        stamina_value: 10_000,
        dealt_bps: 10_000,
        stamina_bell: 0,
        ready_bell: 0,
        from_bell: 0,
        pend_bell: 0,
        op: EntryOp::None,
    };
    write_entry(pd, i, &e).unwrap();
    pd[P::N_ENTRIES] += 1;
}

/// A caravan of `faction` standing on `tile` at bells `B..B+3`.
fn caravan(pd: &mut [u8], i: usize, faction: u8, tile: u8) -> CaravanSlot {
    let mut tiles = [0u8; SLOT_TILES];
    tiles[..3].fill(tile);
    let s = CaravanSlot {
        id: caravan_id(77, i as u32),
        faction,
        n: 3,
        raid_off: RAID_NONE,
        raid_pos: 0,
        first_bell: B,
        tiles,
        raider: 0,
    };
    s.encode(&mut pd[CS::at(i)..CS::at(i) + CS::SIZE]).unwrap();
    s
}

fn slot(pd: &[u8], i: usize) -> CaravanSlot {
    CaravanSlot::decode(&pd[CS::at(i)..CS::at(i) + CS::SIZE]).unwrap()
}

/// build_v2 → the kernel → apply_v2 at bell `B`.
fn clash(pd: &mut [u8]) -> cm::AppliedV2 {
    let built = cm::build_v2(pd, None, B).unwrap();
    let out = resolve_clash(&frontier_ruleset(), &built.input(&[5u8; 32])).unwrap();
    cm::apply_v2(pd, &built, &out).unwrap()
}

/// A hostile host waiting on the caravan's tile (J1's ambush, by the
/// other side) raids it: the slot records the bell, the raider and that it
/// was a resident.
#[test]
fn a_waiting_host_raids_an_unescorted_caravan() {
    let (mut pd, t) = province();
    let tile = open_tile(&t, 0);
    caravan(&mut pd, 0, 0, tile);
    let raider = frontier_abi::addr::host_id(4, 0, 2, 1, 0).unwrap();
    host(&mut pd, 0, raider, 1, tile, 50);
    let built = cm::build_v2(&pd, None, B).unwrap();
    assert_eq!(built.caravans.len(), 1, "the caravan joins the clash");
    assert!(!cm::trivially_quiet_v2(&pd, B).unwrap(), "not quiet");
    let ap = clash(&mut pd);
    assert_eq!(ap.raided, 1);
    assert!(ap.changed());
    let s = slot(&pd, 0);
    assert_eq!(s.raid_off, 0, "raided at its first bell");
    assert_eq!(s.raider, raider);
    assert_eq!(s.raid_pos, cm::RAID_POS_RESIDENT);
    assert!(s.raid_open());
    assert_eq!(s.tile_at(B + 1), None, "no longer exposed once raided");
}

/// An escort of the caravan's faction that holds the tile keeps it safe.
#[test]
fn an_escort_that_holds_keeps_the_caravan() {
    let (mut pd, t) = province();
    let tile = open_tile(&t, 1);
    caravan(&mut pd, 0, 0, tile);
    host(
        &mut pd,
        0,
        frontier_abi::addr::host_id(4, 0, 1, 1, 0).unwrap(),
        0,
        tile,
        400,
    );
    host(
        &mut pd,
        1,
        frontier_abi::addr::host_id(4, 0, 2, 1, 0).unwrap(),
        1,
        tile,
        20,
    );
    let ap = clash(&mut pd);
    assert_eq!(ap.raided, 0, "the escort held");
    assert_eq!(slot(&pd, 0).raid_off, RAID_NONE);
}

/// Only friendly hosts on the tile: quiet, nothing happens.
#[test]
fn a_friendly_tile_is_quiet() {
    let (mut pd, t) = province();
    let tile = open_tile(&t, 2);
    caravan(&mut pd, 0, 0, tile);
    host(
        &mut pd,
        0,
        frontier_abi::addr::host_id(4, 0, 1, 1, 0).unwrap(),
        0,
        tile,
        40,
    );
    assert!(cm::trivially_quiet_v2(&pd, B).unwrap());
    let ap = clash(&mut pd);
    assert_eq!(ap.raided, 0);
}

/// A caravan on a garrison's tile (here: an earlier caravan's) is
/// sheltered: it does not join, and is not raided there.
#[test]
fn a_caravan_on_a_taken_tile_is_sheltered() {
    let (mut pd, t) = province();
    let tile = open_tile(&t, 3);
    caravan(&mut pd, 0, 0, tile);
    caravan(&mut pd, 1, 2, tile);
    host(
        &mut pd,
        0,
        frontier_abi::addr::host_id(4, 0, 2, 1, 0).unwrap(),
        1,
        tile,
        50,
    );
    let built = cm::build_v2(&pd, None, B).unwrap();
    assert_eq!(built.caravans.len(), 1, "one garrison a tile");
    let ap = clash(&mut pd);
    assert_eq!(ap.raided, 1, "the first is raided");
    assert_eq!(slot(&pd, 1).raid_off, RAID_NONE, "the second was sheltered");
}

/// The digests take the slots only when one is in use (an MC Province's
/// digests are unchanged), and then every slot byte counts.
#[test]
fn digests_see_the_slots_only_when_used() {
    let (mut pd, t) = province();
    let ci = vec![0u8; frontier_abi::layout::clash::clash_inputs::SIZE];
    let seed = [3u8; 32];
    let q0 = cm::quiet_digest_v2(&pd, B, 4).unwrap();
    let i0 = cm::input_digest_v2(&pd, &ci, B, &seed).unwrap();
    // The ABI v2 formula without the suffix.
    let st = &pd[cm::STATE_BLOCK];
    let cq = &pd[P::CQ_BLOCK];
    let want =
        permutation_rules::hash::sha256(&[cm::QUIET_DOMAIN_V2, &B.to_le_bytes(), &[4], st, cq]);
    assert_eq!(q0, want, "an MC Province: unchanged");
    caravan(&mut pd, 0, 0, open_tile(&t, 0));
    let q1 = cm::quiet_digest_v2(&pd, B, 4).unwrap();
    assert_ne!(q1, q0);
    assert_ne!(cm::input_digest_v2(&pd, &ci, B, &seed).unwrap(), i0);
    pd[CS::at(0) + 16] ^= 1;
    assert_ne!(
        cm::quiet_digest_v2(&pd, B, 4).unwrap(),
        q1,
        "every slot byte counts"
    );
}
