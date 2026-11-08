//! The clash kernel's identity scheme (`clash::ClashIdentity`, 2026-11-07):
//! the production body and the reference are one algorithm generic over how
//! hosts are named and how the seed, the tie keys and the engagement keys
//! are derived. These tests pin, on fixed data and with the legacy `u64`
//! scheme the chain runs:
//!
//! * `legacy_production_equals_the_reference_on_fixed_data`: the Phase A
//!   body and the step-by-step reference agree on a fixture that fights
//!   (engagements, damage, a field decision, a garrison);
//! * `input_order_never_changes_the_outcome`: residents, arrivals and
//!   garrisons given in any order resolve to the same outcome (the kernel
//!   sorts by identity, never by position);
//! * `an_unrelated_host_never_rerolls_the_others`: inserting a host that
//!   shares no hex with the fight leaves every other host's result and the
//!   engagement count unchanged, under both bodies (the compact unit index
//!   drives no die, tie or ranking);
//! * `a_mirror_scheme_reproduces_the_legacy_outcome`: a newtype scheme that
//!   delegates every formula to the legacy one resolves to the legacy
//!   outcome field for field, so the identity enters only through the
//!   trait and the `u64` wrapper adds nothing.
//!
//! The 4,320-input equivalence of `frontier_clash_equiv.rs` keeps pinning
//! the production body to the reference over the lab's fills; this file is
//! the small fixed-data companion the identity refactor asked for.

use permutation_rules::fixed::BPS_ONE;
use permutation_rules::frontier::addr::host_id;
use permutation_rules::frontier::clash::{
    clash_seed, frontier_ruleset, resolve_clash, resolve_clash_core, resolve_clash_ref,
    resolve_clash_ref_core, ClashIdentity, ClashInput, ClashInputOf, ClashOutcome, Fate, Fighter,
    FighterOf, Garrison, GarrisonOf, Occupancy, Relations,
};
use permutation_rules::frontier::geometry::{tile_offset, ProvinceCoord, PROVINCE_TILES};
use permutation_rules::frontier::host::STAMINA_CAP;
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::{generate_province, ProvinceTerrain};
use permutation_rules::hash::sha256;
use permutation_rules::map::Terrain;
use permutation_rules::rng::{tie_key, Seed};
use permutation_rules::units::UnitType;

const P: ProvinceCoord = ProvinceCoord { p: 3, q: -1 };
const BELL: u32 = 11;
/// The contested hex: the province's centre.
const FIELD: u8 = 30;
/// A hex at distance 4 from the centre (a corner): nothing there touches
/// the field, not even a withdraw.
const FAR: u8 = 0;

fn plains() -> ProvinceTerrain {
    let mut t = generate_province(&[7u8; 32], P);
    t.terrain = [Terrain::Plains; PROVINCE_TILES];
    t
}

fn fighter(id: u64, faction: u8, unit: UnitType, troops: u32, tile: u8) -> Fighter {
    Fighter {
        id,
        faction,
        unit,
        troops: troops * 1000,
        stamina: STAMINA_CAP,
        tile,
        posture: Posture::default(),
        retreat_bps: None,
        dealt_bps: BPS_ONE,
    }
}

fn arrival(id: u64, faction: u8, unit: UnitType, troops: u32, tile: u8) -> Fighter {
    Fighter {
        posture: Posture::Stance(Stance::Assault),
        ..fighter(id, faction, unit, troops, tile)
    }
}

fn garrison(id: u64, faction: u8, tile: u8, troops: u32) -> Garrison {
    Garrison {
        id,
        faction,
        tile,
        troops: troops * 1000,
        walls: true,
        posture: Posture::default(),
    }
}

/// The fixture: faction 0 holds the centre with two residents and the
/// holding's garrison; faction 1 attacks it with two arrivals; faction 2
/// stands alone on another hex. Everyone is hostile to everyone.
struct Fixture {
    terrain: ProvinceTerrain,
    residents: Vec<Fighter>,
    garrisons: Vec<Garrison>,
    arrivals: Vec<Fighter>,
}

fn fixture() -> Fixture {
    Fixture {
        terrain: plains(),
        residents: vec![
            fighter(host_id(3, -1, 2, 1, 1), 0, UnitType::Spearman, 9_000, FIELD),
            fighter(host_id(3, -1, 2, 1, 2), 0, UnitType::Archer, 6_000, FIELD),
            fighter(host_id(3, -1, 5, 1, 1), 2, UnitType::Pikeman, 7_000, 44),
        ],
        garrisons: vec![garrison(host_id(3, -1, 2, 1, 0), 0, FIELD, 4_000)],
        arrivals: vec![
            arrival(host_id(3, -1, 7, 2, 1), 1, UnitType::Knight, 12_000, FIELD),
            arrival(host_id(3, -1, 7, 2, 2), 1, UnitType::Horseman, 8_000, FIELD),
        ],
    }
}

fn input<'a>(f: &'a Fixture, seed: &Seed) -> ClashInput<'a> {
    ClashInput {
        province: P,
        bell: BELL,
        seed: *seed,
        terrain: &f.terrain,
        residents: &f.residents,
        garrisons: &f.garrisons,
        arrivals: &f.arrivals,
        relations: Relations::ALL_HOSTILE,
        occupancy: Occupancy::EMPTY,
    }
}

fn seed() -> Seed {
    sha256(&[b"identity"])
}

/// Hex distance between two tiles (axial coordinates).
fn distance(a: u8, b: u8) -> i32 {
    let (x, y) = (tile_offset(a).unwrap(), tile_offset(b).unwrap());
    let (dq, dr) = (x.q - y.q, x.r - y.r);
    (dq.abs() + dr.abs() + (dq + dr).abs()) / 2
}

#[test]
fn legacy_production_equals_the_reference_on_fixed_data() {
    let f = fixture();
    let inp = input(&f, &seed());
    let a = resolve_clash(&frontier_ruleset(), &inp).unwrap();
    let b = resolve_clash_ref(&frontier_ruleset(), &inp).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.digest(), b.digest());
    // The fixture fights: engagements happened, the garrison and at least
    // one host took damage, and the field was decided.
    assert!(a.engagements > 0, "{a:?}");
    let g = &a.garrisons[0];
    assert_eq!(g.id, host_id(3, -1, 2, 1, 0));
    assert!(g.troops < 4_000 * 1000, "{g:?}");
    assert!(
        a.fighters
            .iter()
            .any(|x| x.engaged && x.troops < 6_000 * 1000),
        "{a:?}"
    );
    let outsider = a.fighter(host_id(3, -1, 5, 1, 1)).unwrap();
    assert_eq!(
        (outsider.fate, outsider.engaged, outsider.troops),
        (Fate::Stays { tile: 44 }, false, 7_000 * 1000),
        "the lone host on another hex is untouched"
    );
    // Results are in identity order.
    assert!(a.fighters.windows(2).all(|w| w[0].id < w[1].id));
}

#[test]
fn input_order_never_changes_the_outcome() {
    let f = fixture();
    let base = resolve_clash(&frontier_ruleset(), &input(&f, &seed())).unwrap();
    let mut g = fixture();
    g.residents.reverse();
    g.arrivals.reverse();
    let mut h = fixture();
    h.residents.rotate_left(1);
    h.arrivals.swap(0, 1);
    for alt in [&g, &h] {
        for body in [resolve_clash, resolve_clash_ref] {
            let out = body(&frontier_ruleset(), &input(alt, &seed())).unwrap();
            assert_eq!(out, base);
        }
    }
}

#[test]
fn an_unrelated_host_never_rerolls_the_others() {
    assert!(distance(FIELD, FAR) >= 2, "{}", distance(FIELD, FAR));
    assert!(distance(44, FAR) >= 2, "{}", distance(44, FAR));
    let f = fixture();
    let mut g = fixture();
    // A new host of a fourth faction, whose id sorts *before* every other
    // (so every unit index shifts by one), on a hex nobody can reach.
    let newcomer = host_id(3, -1, 0, 1, 0);
    assert!(g.residents.iter().all(|r| newcomer < r.id));
    g.residents
        .push(fighter(newcomer, 3, UnitType::Crossbowman, 5_000, FAR));
    for body in [resolve_clash, resolve_clash_ref] {
        let base = body(&frontier_ruleset(), &input(&f, &seed())).unwrap();
        let more = body(&frontier_ruleset(), &input(&g, &seed())).unwrap();
        assert_eq!(more.engagements, base.engagements);
        assert_eq!(more.garrisons, base.garrisons);
        assert_eq!(more.fighters.len(), base.fighters.len() + 1);
        for x in &base.fighters {
            assert_eq!(more.fighter(x.id), Some(x), "{x:?}");
        }
        let n = more.fighter(newcomer).unwrap();
        assert_eq!(
            (n.fate, n.engaged, n.troops),
            (Fate::Stays { tile: FAR }, false, 5_000 * 1000)
        );
    }
}

/// A scheme that names hosts by a newtype and delegates every formula to
/// the legacy one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Mirror(u64);

impl ClashIdentity for Mirror {
    type Province = ProvinceCoord;
    type Key = [u8; 9];
    fn clash_seed(seed: &Seed, province: &ProvinceCoord, bell: u32) -> Seed {
        clash_seed(seed, *province, bell)
    }
    fn wedge(province: &ProvinceCoord) -> u8 {
        province.wedge().unwrap_or(0)
    }
    fn tie(cs: &Seed, id: &Mirror) -> u64 {
        tie_key(cs, id.0)
    }
    fn key(&self, city: bool) -> [u8; 9] {
        let mut k = [0u8; 9];
        k[0] = city as u8;
        k[1..].copy_from_slice(&self.0.to_le_bytes());
        k
    }
    fn sort_by_order<T: Copy>(v: &mut [T], key: impl Fn(&T) -> (u64, u64, Mirror)) {
        v.sort_by_key(key)
    }
    fn sort_by_id<T: Copy>(v: &mut [T], key: impl Fn(&T) -> Mirror) {
        v.sort_by_key(key)
    }
}

fn mirror_fighter(f: &Fighter) -> FighterOf<Mirror> {
    FighterOf {
        id: Mirror(f.id),
        faction: f.faction,
        unit: f.unit,
        troops: f.troops,
        stamina: f.stamina,
        tile: f.tile,
        posture: f.posture,
        retreat_bps: f.retreat_bps,
        dealt_bps: f.dealt_bps,
    }
}

fn mirror_garrison(g: &Garrison) -> GarrisonOf<Mirror> {
    GarrisonOf {
        id: Mirror(g.id),
        faction: g.faction,
        tile: g.tile,
        troops: g.troops,
        walls: g.walls,
        posture: g.posture,
    }
}

#[test]
fn a_mirror_scheme_reproduces_the_legacy_outcome() {
    let f = fixture();
    let legacy: ClashOutcome = resolve_clash(&frontier_ruleset(), &input(&f, &seed())).unwrap();
    let residents: Vec<FighterOf<Mirror>> = f.residents.iter().map(mirror_fighter).collect();
    let arrivals: Vec<FighterOf<Mirror>> = f.arrivals.iter().map(mirror_fighter).collect();
    let garrisons: Vec<GarrisonOf<Mirror>> = f.garrisons.iter().map(mirror_garrison).collect();
    let inp = ClashInputOf::<Mirror> {
        province: P,
        bell: BELL,
        seed: seed(),
        terrain: &f.terrain,
        residents: &residents,
        garrisons: &garrisons,
        arrivals: &arrivals,
        relations: Relations::ALL_HOSTILE,
        occupancy: Occupancy::EMPTY,
    };
    for out in [
        resolve_clash_core(&frontier_ruleset(), &inp).unwrap(),
        resolve_clash_ref_core(&frontier_ruleset(), &inp).unwrap(),
    ] {
        assert_eq!(out.bell, legacy.bell);
        assert_eq!(out.engagements, legacy.engagements);
        assert_eq!(out.fighters.len(), legacy.fighters.len());
        for (m, l) in out.fighters.iter().zip(&legacy.fighters) {
            assert_eq!(m.id, Mirror(l.id));
            assert_eq!(
                (m.arrival, m.troops, m.stamina, m.fate, m.engaged),
                (l.arrival, l.troops, l.stamina, l.fate, l.engaged)
            );
        }
        for (m, l) in out.garrisons.iter().zip(&legacy.garrisons) {
            assert_eq!(m.id, Mirror(l.id));
            assert_eq!(
                (m.troops, m.attackers_hold, m.holders, m.defender_present),
                (l.troops, l.attackers_hold, l.holders, l.defender_present)
            );
        }
    }
}
