//! `cq_*`: the shared conquest step and the v2 clash model over Province
//! v2 bytes (MC contract §5.7, §3.2–§3.6, §3.10, G11 extended at model
//! level). Each scenario drives the resolve path (build_v2 → kernel →
//! apply_v2 → report_from_outcome → settle_bell → step → finish_bell) and
//! the skip path (camp check → report_quiet → settle_bell → step →
//! finish_bell) on two copies of one Province and requires them
//! byte-identical after every quiet bell.

use frontier_abi::addr::host_id;
use frontier_abi::clash_model::{self as cm, TERRAINS};
use frontier_abi::conquest_model::{self as qm, BellReport, Record, StepOut, StepParams};
use frontier_abi::entry::{read_entry, write_entry, Entry, EntryOp};
use frontier_abi::layout::province::entry as E;
use frontier_abi::v2::kernel::keep::{self as kkeep, Keep};
use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, province as P, site as SM};
use frontier_abi::v2::layout::world::march_state as MS;
use frontier_abi::v2::layout::{write_header, AccountKind};
use frontier_abi::v2::log::event;
use frontier_abi::v2::presets::MC_LOCAL_7D;
use permutation_rules::frontier::clash::{frontier_ruleset, resolve_clash};
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::terrain::generate_province;

const GENESIS: i64 = 1_788_998_400;

fn prm() -> StepParams {
    StepParams {
        genesis_ts: GENESIS,
        end_bell: 1_008,
        cq: MC_LOCAL_7D.cq,
    }
}

/// A fresh ring-`r` Province v2 at (p, q) with no holdings, no camp due
/// for a long time, and its keep opened with `guard` troops.
fn province(p: i32, q: i32, guard: u32) -> Vec<u8> {
    let c = ProvinceCoord::new(p, q);
    let t = generate_province(&[7u8; 32], c);
    let mut pd = vec![0u8; P::SIZE];
    assert!(write_header(&mut pd, AccountKind::Province, 1));
    pd[P::P..P::P + 2].copy_from_slice(&(p as i16).to_le_bytes());
    pd[P::Q..P::Q + 2].copy_from_slice(&(q as i16).to_le_bytes());
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
    // camp: none; its daily check far away (both paths run it anyway)
    let camp = cm::Camp {
        tile: 0,
        state: 0,
        troops: 0,
        next_check_day: 1_000,
        gen: 0,
    };
    camp.write(&mut pd).unwrap();
    let tile = kkeep::keep_tile(&t, &t.sites, t.site_count).unwrap();
    let mut kp = MC_LOCAL_7D.cq.keep_params();
    kp.home_guard = guard;
    let k = kkeep::open(c, c.wedge().unwrap(), 3, tile, &kp, 0).unwrap();
    qm::write_keep(&mut pd, &k).unwrap();
    pd
}

fn host(id: u64, faction: u8, tile: u8, troops_whole: u32, from: u32) -> Entry {
    Entry {
        id,
        faction,
        unit: 0, // Spearman
        tile,
        state: E::STATE_ROSTER,
        troops: troops_whole * 1_000,
        stamina_value: 120,
        dealt_bps: 10_000,
        stamina_bell: 0,
        ready_bell: 0,
        from_bell: from,
        pend_bell: 0,
        op: EntryOp::None,
    }
}

fn resolve_bell(pd: &mut [u8], b: u32) -> StepOut {
    let built = cm::build_v2(pd, None, b).unwrap();
    let out = resolve_clash(&frontier_ruleset(), &built.input(&[5u8; 32])).unwrap();
    let ap = cm::apply_v2(pd, &built, &out).unwrap();
    let rep = qm::report_from_outcome(&built, &out).unwrap();
    let settled = cm::settle_bell(pd, b).unwrap();
    let so = qm::step(pd, b, &rep, &prm()).unwrap();
    cm::finish_bell(pd, b, ap.changed() || settled || so.roster_changed).unwrap();
    so
}

fn skip_bell(pd: &mut [u8], b: u32) -> StepOut {
    let mut changed = false;
    let t = cm::terrain_of(pd).unwrap();
    let keep_tile = qm::read_keep(pd).unwrap().map(|k| k.tile);
    if let Some((c, spawned)) = cm::camp_check_v2(pd, &t, b, keep_tile).unwrap() {
        c.write(pd).unwrap();
        changed |= spawned;
    }
    // the bell is quiet: the trivial test or the kernel's
    let quiet = cm::trivially_quiet_v2(pd, b).unwrap() || {
        let built = cm::build_v2(pd, None, b).unwrap();
        permutation_rules::frontier::clash::is_quiet(&frontier_ruleset(), &built.input(&[0; 32]))
            .unwrap()
    };
    assert!(quiet, "bell {b} is not quiet");
    let rep = qm::report_quiet(pd, b).unwrap();
    changed |= cm::settle_bell(pd, b).unwrap();
    let so = qm::step(pd, b, &rep, &prm()).unwrap();
    cm::finish_bell(pd, b, changed || so.roster_changed).unwrap();
    so
}

/// Drives bells `b0..b1` on both paths; returns the resolve path's events.
fn run_both(a: &mut [u8], s: &mut [u8], b0: u32, b1: u32) -> Vec<(u32, StepOut)> {
    let mut outs = Vec::new();
    for b in b0..b1 {
        let ra = resolve_bell(a, b);
        let rs = skip_bell(s, b);
        assert_eq!(ra, rs, "step outputs differ at bell {b}");
        assert!(a == s, "resolve and skip Provinces differ after bell {b}");
        if ra.n > 0 || ra.keep_taken.is_some() {
            outs.push((b, ra));
        }
    }
    outs
}

fn set_record(pd: &mut [u8], s: usize, r: Record) {
    r.write(pd, s).unwrap();
}

fn set_site(pd: &mut [u8], s: usize, state: u8, faction: u8, order: u8, gen: u8, garrison: u32) {
    let o = P::site(s);
    pd[o + SM::STATE] = state;
    pd[o + SM::FACTION] = faction;
    pd[o + SM::ORDER] = order;
    pd[o + SM::GEN] = gen;
    pd[o + SM::GARRISON..o + SM::GARRISON + 4].copy_from_slice(&garrison.to_le_bytes());
}

/// §3.2: a hostile host alone on an empty keep counts 72 bells, takes it
/// at the 72nd, hands half of itself to the keep and goes home with the
/// rest; resolve ≡ skip every bell (G11 extended).
#[test]
fn cq_keep_taken_after_72_bells_resolve_equals_skip() {
    let (p, q) = (5, -1);
    let mut a = province(p, q, 0);
    let k0 = qm::read_keep(&a).unwrap().unwrap();
    assert!(!k0.heartland_safe, "ring 4 is outside every heartland");
    let f = (k0.holder + 1) % 6;
    let id = host_id(0, 4, 2, 0, 1).unwrap();
    write_entry(&mut a, 0, &host(id, f, k0.tile, 20_000, 0)).unwrap();
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 1, 80);
    // the contest horn, then the taking at progress 72
    assert_eq!(outs[0].0, 1);
    assert_eq!(outs[0].1.events()[0].code, event::KEEP_CONTEST);
    let (tb, taken) = outs.iter().find(|(_, o)| o.keep_taken.is_some()).unwrap();
    assert_eq!(*tb, 72);
    let t = taken.keep_taken.unwrap();
    assert_eq!((t.from, t.to, t.garrison), (k0.holder, f, 10_000));
    assert_eq!(t.donor_host_id, id);
    let k = qm::read_keep(&a).unwrap().unwrap();
    assert_eq!((k.holder, k.troops, k.gen, k.changes), (f, 10_000, 1, 1));
    assert_eq!(k.consolidated_until_bell, 72 + 1 + 288);
    // the donor goes home with the rest (a retire-style Leave)
    let e = read_entry(&a, 0).unwrap();
    assert_eq!(e.state, E::STATE_DEPARTED);
    assert_eq!(e.troops, 10_000_000);
    assert!(frontier_abi::v2::entry::is_retire(&a, 0));
    assert_eq!(a[P::keeps_taken_by(f as usize)], 1);
    // R-01: the next clash validates with the new garrison
    assert!(kkeep::garrison(&k).is_ok());
}

/// §3.2 step 2: a defender of the holder on the hex breaks the contest.
#[test]
fn cq_keep_contest_broken_by_a_defender() {
    let mut a = province(5, -1, 0);
    let k0 = qm::read_keep(&a).unwrap().unwrap();
    let f = (k0.holder + 1) % 6;
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 2, 0, 1).unwrap(), f, k0.tile, 500, 0),
    )
    .unwrap();
    let mut s = a.clone();
    run_both(&mut a, &mut s, 1, 10);
    assert_eq!(qm::read_keep(&a).unwrap().unwrap().progress, 9);
    // the attacker leaves (destroyed elsewhere); a defender alone stands
    write_entry(&mut a, 0, &Entry::FREE).unwrap();
    write_entry(
        &mut a,
        1,
        &host(host_id(4, -1, 1, 0, 1).unwrap(), k0.holder, k0.tile, 300, 0),
    )
    .unwrap();
    s.copy_from_slice(&a);
    let outs = run_both(&mut a, &mut s, 10, 12);
    assert_eq!(outs[0].1.events()[0].code, event::KEEP_BROKEN);
    let k = qm::read_keep(&a).unwrap().unwrap();
    assert_eq!((k.contender, k.progress), (KP::NONE, 0));
}

/// §3.2 step 1: a heartland keep never counts.
#[test]
fn cq_heartland_keep_never_counts() {
    let mut a = province(2, 0, 0);
    let k0 = qm::read_keep(&a).unwrap().unwrap();
    assert!(k0.heartland_safe);
    let f = (k0.holder + 1) % 6;
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 2, 0, 1).unwrap(), f, k0.tile, 500, 0),
    )
    .unwrap();
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 1, 100);
    assert!(outs.is_empty());
    assert_eq!(qm::read_keep(&a).unwrap().unwrap(), k0);
}

/// §3.4, §3.6, §3.7: a siege on a genesis Free City completes after
/// `required` bells (no vigil) and flips the mirror for the captor into
/// the reserved slot, credited (K-26: genesis Free Cities always are).
#[test]
fn cq_free_city_siege_completes_into_the_reserved_slot() {
    let mut a = province(5, -1, 100);
    let site = 3usize;
    let tile = a[P::SITES + site];
    set_site(&mut a, site, SM::STATE_FREE_CITY, 6, 0, 0, 0);
    let f = 2u8;
    let src = host_id(0, 4, 1, 0, 0).unwrap();
    set_record(
        &mut a,
        site,
        Record {
            kind: CR::KIND_SIEGE,
            faction: f,
            flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
            required: 36,
            target: CR::target(CR::TARGET_FREE_CITY, 2),
            bell: 10,
            actor: 77,
            src,
            ..Record::ZERO
        },
    );
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 1, 0, 1).unwrap(), f, tile, 800, 0),
    )
    .unwrap();
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 11, 48);
    let (b, o) = outs
        .iter()
        .find(|(_, o)| o.events().iter().any(|e| e.site == site as u8))
        .unwrap();
    assert_eq!(*b, 46, "36 counted bells from 11");
    let e = o.events().iter().find(|e| e.site == site as u8).unwrap();
    assert_eq!(e.code, event::CAPTURE_DUE | event::DETAIL);
    let m = P::site(site);
    assert_eq!(a[m + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(a[m + SM::FACTION], f);
    assert_eq!(a[m + SM::ORDER], 2);
    assert_eq!(a[m + SM::GEN], 1);
    assert_eq!(
        u16::from_le_bytes([a[m + SM::HELD_SINCE_HOUR], a[m + SM::HELD_SINCE_HOUR + 1]]),
        8,
        "⌈47 / 6⌉"
    );
    let r = Record::read(&a, site).unwrap();
    assert_eq!(r.kind, CR::KIND_CAPTURE_DUE);
    assert_eq!(r.flags, CR::FLAG_CREDITED);
    assert_eq!((r.bell, r.actor, r.src), (46, 77, src));
    assert_eq!(a[P::captures_by(f as usize)], 1);
}

/// §3.4 failure (K-06): a defender on the hex fails the siege, owes the
/// stake to the holding at its generation, bars the attacker's faction
/// for 36 bells and owes the reserved slot back.
#[test]
fn cq_siege_broken_by_defender_owes_stake_slot_and_immunity() {
    let mut a = province(5, -1, 100);
    let site = 1usize;
    let tile = a[P::SITES + site];
    let owner = 4u8;
    set_site(&mut a, site, SM::STATE_HOLDING, owner, 2, 3, 0);
    let f = 1u8;
    set_record(
        &mut a,
        site,
        Record {
            kind: CR::KIND_SIEGE,
            faction: f,
            flags: CR::FLAG_HELD,
            required: 40,
            target: CR::target(CR::TARGET_OTHER, 3),
            bell: 20,
            actor: 9,
            src: host_id(0, 4, 2, 0, 0).unwrap(),
            ..Record::ZERO
        },
    );
    // the owner's host stands on the hex (the attacker is gone)
    write_entry(
        &mut a,
        0,
        &host(
            host_id(5, -1, site as u8, 3, 1).unwrap(),
            owner,
            tile,
            400,
            0,
        ),
    )
    .unwrap();
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 21, 22);
    let e = outs[0].1.events()[0];
    assert_eq!(e.code, event::SIEGE_FAILED | event::DETAIL);
    let r = Record::read(&a, site).unwrap();
    assert_eq!(r.kind, CR::KIND_NONE);
    assert_eq!(r.faction, f, "barred: the besieging faction only");
    assert_eq!(r.bell, 21 + 1 + 36);
    assert_eq!(r.flags, CR::FLAG_STAKE_TO_HOLDING | CR::FLAG_SLOT_OWED);
    assert_eq!((r.progress, r.required, r.actor), (3, 3, 9));
    assert!(r.bars(f, 50) && !r.bars(2, 50) && !r.bars(f, 58));
    assert!(r.owes());
}

/// §3.4 failure, deserted: nobody on the hex → no immunity, stake burned.
#[test]
fn cq_deserted_siege_grants_nothing() {
    let mut a = province(5, -1, 100);
    let site = 1usize;
    set_site(&mut a, site, SM::STATE_HOLDING, 4, 1, 0, 0);
    set_record(
        &mut a,
        site,
        Record {
            kind: CR::KIND_SIEGE,
            faction: 1,
            flags: CR::FLAG_HELD,
            required: 40,
            target: CR::target(CR::TARGET_FIRST, 0),
            bell: 20,
            ..Record::ZERO
        },
    );
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 21, 22);
    assert_eq!(outs[0].1.events()[0].code, event::SIEGE_FAILED);
    let r = Record::read(&a, site).unwrap();
    assert_eq!(
        r,
        Record {
            faction: CR::BARRED_NONE,
            ..Record::ZERO
        }
    );
    assert!(!r.owes());
}

/// §3.5: a first holding is occupied (never taken); the occupier walking
/// away liberates it without Respite (R-05), the owner's own liberation
/// with Respite against the occupier only.
#[test]
fn cq_occupation_and_liberation() {
    let mut a = province(5, -1, 100);
    let site = 0usize;
    let tile = a[P::SITES + site];
    let owner = 3u8;
    set_site(&mut a, site, SM::STATE_HOLDING, owner, 1, 0, 0);
    let f = 5u8;
    set_record(
        &mut a,
        site,
        Record {
            kind: CR::KIND_SIEGE,
            faction: f,
            flags: CR::FLAG_HELD,
            required: 36,
            target: CR::target(CR::TARGET_FIRST, 0),
            vigil_start: 0,
            bell: 130,
            src: 55,
            ..Record::ZERO
        },
    );
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 1, 0, 1).unwrap(), f, tile, 900, 0),
    )
    .unwrap();
    let mut s = a.clone();
    // the owner's vigil 00:00–08:00 UTC: genesis is a UTC midnight, so
    // bells 0..48 of every 144 are covered: 131..=143 count 13, the
    // vigil 144..192 pauses, 192..=214 count the other 23
    let outs = run_both(&mut a, &mut s, 131, 220);
    let (b, o) = &outs[0];
    assert_eq!(o.events()[0].code, event::OCCUPIED);
    assert_eq!(*b, 214, "the vigil (bells 144..192) pauses it");
    let r = Record::read(&a, site).unwrap();
    assert_eq!((r.kind, r.faction, r.bell), (CR::KIND_OCCUPATION, f, *b));
    // D-9 revised (integ-W1): the stake is owed to `src` from completion.
    assert_eq!(r.flags, CR::FLAG_STAKE_TO_SRC);
    assert!(r.owes());
    // the occupation moves points, not the mirror (D9)
    assert_eq!(a[P::site(site) + SM::FACTION], owner);
    let w = qm::control_weights(&a, 216).unwrap();
    assert!(w[f as usize] > 0 && w[owner as usize] == 0);
    // the occupier walks away: liberated, no Respite
    write_entry(&mut a, 0, &Entry::FREE).unwrap();
    s.copy_from_slice(&a);
    let outs = run_both(&mut a, &mut s, 220, 221);
    assert_eq!(outs[0].1.events()[0].code, event::LIBERATED | event::DETAIL);
    let r = Record::read(&a, site).unwrap();
    assert_eq!(
        (r.kind, r.faction, r.flags),
        (0, CR::BARRED_NONE, CR::FLAG_STAKE_TO_SRC)
    );
    assert_eq!(r.src, 55);
}

/// §3.5 Respite (K-09): expiry at tenure grants Respite against the
/// occupier's faction only.
#[test]
fn cq_occupation_expires_with_respite() {
    let mut a = province(5, -1, 100);
    let site = 0usize;
    let tile = a[P::SITES + site];
    set_site(&mut a, site, SM::STATE_HOLDING, 3, 1, 0, 0);
    let f = 5u8;
    set_record(
        &mut a,
        site,
        Record {
            kind: CR::KIND_OCCUPATION,
            faction: f,
            target: CR::target(CR::TARGET_FIRST, 0),
            bell: 10,
            ..Record::ZERO
        },
    );
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 1, 0, 1).unwrap(), f, tile, 900, 0),
    )
    .unwrap();
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 11, 90);
    let (b, o) = &outs[0];
    assert_eq!(*b, 10 + 72);
    assert_eq!(o.events()[0].code, event::OCCUPATION_EXPIRED);
    let r = Record::read(&a, site).unwrap();
    // §3.5 as written: `end + respite_bells` (D-12 withdrawn, integ-W1);
    // the stake was settled before (flags 0), so nothing is owed.
    assert_eq!((r.faction, r.bell, r.flags), (f, 82 + 72, 0));
    assert!(r.bars(f, 82 + 71) && !r.bars(f, 82 + 72) && !r.bars(3, 90));
}

/// §3.5 Respite on the owner's own liberation (K-09, R-05): the owner's
/// side retakes the hex before tenure → LIBERATED without the `no_respite`
/// detail bit, Respite `end + respite_bells` against the occupier's
/// faction only; an unsettled stake to `src` stays owed (integ-W1).
#[test]
fn cq_owner_liberation_gives_respite_against_the_occupier_only() {
    let mut a = province(5, -1, 100);
    let site = 0usize;
    let tile = a[P::SITES + site];
    let owner = 3u8;
    set_site(&mut a, site, SM::STATE_HOLDING, owner, 1, 0, 0);
    let f = 5u8;
    set_record(
        &mut a,
        site,
        Record {
            kind: CR::KIND_OCCUPATION,
            faction: f,
            flags: CR::FLAG_STAKE_TO_SRC,
            target: CR::target(CR::TARGET_FIRST, 0),
            bell: 10,
            src: 77,
            ..Record::ZERO
        },
    );
    // the owner's host, 900 troops, stands on its own hex; no occupier host
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 1, 0, 1).unwrap(), owner, tile, 900, 0),
    )
    .unwrap();
    let out = resolve_bell(&mut a, 20);
    let ev = out
        .events()
        .iter()
        .find(|e| e.site == site as u8)
        .copied()
        .expect("the occupation ends");
    assert_eq!(ev.code, event::LIBERATED, "with Respite: no detail bit");
    assert_eq!(ev.faction, f);
    let r = Record::read(&a, site).unwrap();
    let respite = prm().cq.respite_bells as u32;
    assert_eq!(
        (r.kind, r.faction, r.bell, r.flags, r.src),
        (CR::KIND_NONE, f, 20 + respite, CR::FLAG_STAKE_TO_SRC, 77)
    );
    assert!(r.bars(f, 21) && !r.bars(owner, 21) && !r.bars(1, 21));
    assert!(r.owes(), "the unsettled stake stays owed");
    assert_eq!(a[P::site(site) + SM::FACTION], owner, "D9");
}

/// §5.6 0x61, K-21 at the full fill: a 12-site Province (holdings and
/// Free Cities) with the camp present and the keep at a 100-troop guard
/// builds 13 garrisons (12 sites + the keep, the camp dropped), resolves,
/// and `apply_v2` writes the keep's losses.
#[test]
fn cq_twelve_sites_and_the_keep_drop_the_camp_and_write_the_keep() {
    let (p, q) = (2..30)
        .flat_map(|p| (-30..30).map(move |q| (p, q)))
        .find(|&(p, q)| {
            let c = ProvinceCoord::new(p, q);
            c.ring() >= 4 && generate_province(&[7u8; 32], c).site_count == 12
        })
        .expect("a 12-site province");
    let mut a = province(p, q, 100);
    for s in 0..12 {
        if s % 3 == 0 {
            set_site(&mut a, s, SM::STATE_FREE_CITY, 6, 0, 0, 300_000);
        } else {
            set_site(&mut a, s, SM::STATE_HOLDING, (s % 6) as u8, 1, 0, 50_000);
        }
    }
    let k0 = qm::read_keep(&a).unwrap().unwrap();
    let sites: Vec<u8> = a[P::SITES..P::SITES + 12].to_vec();
    let camp_tile = (0..61u8)
        .find(|t| *t != k0.tile && !sites.contains(t))
        .unwrap();
    cm::Camp {
        tile: camp_tile,
        state: 1,
        troops: 400,
        next_check_day: 1_000,
        gen: 1,
    }
    .write(&mut a)
    .unwrap();
    let att = (k0.holder + 1) % 6;
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 1, 0, 1).unwrap(), att, k0.tile, 5_000, 0),
    )
    .unwrap();
    let b = 7;
    let built = cm::build_v2(&a, None, b).unwrap();
    assert_eq!(built.base.gar_site.len(), 12, "the 12 site garrisons");
    assert_eq!(built.base.garrisons.len(), 13, "12 sites + the keep");
    assert!(
        !built.base.gar_site.contains(&cm::CAMP_SITE),
        "the camp is dropped at 12 site garrisons"
    );
    let keep = built.keep.unwrap();
    assert_eq!(built.base.garrisons.last().unwrap().id, keep.id);
    let out = resolve_clash(&frontier_ruleset(), &built.input(&[5u8; 32])).unwrap();
    let ap = cm::apply_v2(&mut a, &built, &out).unwrap();
    assert!(ap.keep_changed, "the keep fought");
    let k1 = qm::read_keep(&a).unwrap().unwrap();
    assert!(k1.troops < k0.troops, "apply_v2 wrote the keep's losses");
}

/// §3.10: hour snapshots at `b mod 6 == 0`; FoldMarch combines seven
/// members strictly in order, waits on lag and loses an overwritten hour.
#[test]
fn cq_snapshots_and_the_march_fold() {
    let mut a = province(5, -1, 100);
    set_site(&mut a, 0, SM::STATE_HOLDING, 2, 1, 0, 0);
    set_site(&mut a, 1, SM::STATE_FREE_CITY, 6, 0, 0, 300_000);
    let mut s = a.clone();
    let outs = run_both(&mut a, &mut s, 1, 13);
    assert!(outs.is_empty(), "no events, only snapshots");
    let w6 = qm::snapshot_slot(&a, 1).unwrap().unwrap();
    assert_eq!(w6[2], 100, "a Hamlet first holding, no garrison: 1.0");
    assert!(
        w6[6] > 100,
        "a Free City with 300 troops counts for neutral"
    );
    assert_eq!(qm::snapshot_slot(&a, 2).unwrap(), Some(w6));
    assert_eq!(qm::snapshot_slot(&a, 3).unwrap(), None);
    // the fold
    let (m, n) = frontier_abi::v2::addr::march_of(5, -1);
    let members = frontier_abi::v2::addr::march_members(m, n);
    let idx = members.iter().position(|x| *x == (5, -1)).unwrap();
    let mut ms: [Option<&[u8]>; 7] = [None; 7];
    ms[idx] = Some(&a);
    let hf = qm::fold(&ms, 1).unwrap();
    assert_eq!(hf.weight[2], 100);
    assert!(!hf.lost);
    assert_eq!(
        hf.controller,
        frontier_abi::v2::kernel::control::Controller::Side(6),
        "the neutral side outweighs the holding"
    );
    assert_eq!(
        qm::fold(&ms, 3),
        Err(qm::FoldError::TooEarly),
        "lag only waits"
    );
    assert_eq!(qm::first_hour(&ms).unwrap(), Some(0));
    let mut march = vec![0u8; MS::SIZE];
    assert!(write_header(&mut march, AccountKind::MarchState, 1));
    let h0 = qm::fold(&ms, 0).unwrap();
    qm::apply_fold(&mut march, &h0, 6).unwrap();
    assert_eq!(
        qm::apply_fold(&mut march, &h0, 6),
        Err(qm::FoldError::OutOfOrder)
    );
    let log = qm::apply_fold(&mut march, &hf, 6).unwrap();
    assert_eq!(log.controller, 6);
    assert_eq!(log.credit, MS::CONTROLLER_NONE, "neutral earns nothing");
    assert_eq!(log.to_bytes().len(), 44);
    // an overwritten slot loses the hour (no credit to anyone)
    let mut late = a.clone();
    late[P::snap(1)..P::snap(1) + 4].copy_from_slice(&7u32.to_le_bytes());
    late[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&100u32.to_le_bytes());
    let mut ms2: [Option<&[u8]>; 7] = [None; 7];
    ms2[idx] = Some(&late);
    let lost = qm::fold(&ms2, 1).unwrap();
    assert!(lost.lost, "slot 1 moved past hour 1");
    assert!(!qm::fold(&ms2, 2).unwrap().lost);
}

/// §5.6 0x61, K-21: the v2 clash input carries Free City garrisons, the
/// camp only while fewer than 12 site garrisons stand, and the keep last;
/// the v2 input digest covers the conquest block.
#[test]
fn cq_build_v2_garrisons_and_digest() {
    let mut a = province(5, -1, 100);
    let n = a[P::SITE_COUNT] as usize;
    for s in 0..n {
        if s % 2 == 0 {
            set_site(&mut a, s, SM::STATE_HOLDING, 1, 1, 0, 50_000);
        } else {
            set_site(&mut a, s, SM::STATE_FREE_CITY, 6, 0, 0, 300_000);
        }
    }
    let built = cm::build_v2(&a, None, 5).unwrap();
    assert_eq!(built.base.gar_site.len(), n);
    assert_eq!(built.base.garrisons.len(), n + 1, "the keep is last");
    let keep = built.keep.unwrap();
    assert_eq!(built.base.garrisons.last().unwrap().id, keep.id);
    assert_eq!(keep.id, u64::MAX - 0x1_0000);
    for (g, &s) in built.base.garrisons.iter().zip(&built.base.gar_site) {
        let fc = a[P::site(s as usize) + SM::STATE] == SM::STATE_FREE_CITY;
        assert_eq!(g.faction == 6, fc);
    }
    let ci = vec![0u8; frontier_abi::layout::clash::clash_inputs::SIZE];
    let d2 = cm::input_digest_v2(&a, &ci, 5, &[1; 32]).unwrap();
    assert_ne!(d2, cm::input_digest(&a, &ci, 5, &[1; 32]).unwrap());
    let mut b = a.clone();
    b[P::KEEP + KP::PROGRESS] = 1;
    assert_ne!(d2, cm::input_digest_v2(&b, &ci, 5, &[1; 32]).unwrap());
    assert_ne!(
        cm::quiet_digest_v2(&a, 5, 1).unwrap(),
        cm::quiet_digest_v2(&b, 5, 1).unwrap()
    );
    // a resident on a Free City's hex is never trivially quiet
    let fc_tile = a[P::SITES + 1];
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 1, 0, 1).unwrap(), 2, fc_tile, 100, 0),
    )
    .unwrap();
    assert!(!cm::trivially_quiet_v2(&a, 5).unwrap());
}

/// The CONQUEST payload pins the records and the keep.
#[test]
fn cq_conquest_payload_pins_the_state() {
    let mut a = province(5, -1, 100);
    let k0: Keep = qm::read_keep(&a).unwrap().unwrap();
    let f = (k0.holder + 1) % 6;
    write_entry(
        &mut a,
        0,
        &host(host_id(0, 4, 2, 0, 1).unwrap(), f, k0.tile, 500, 0),
    )
    .unwrap();
    let rep = BellReport {
        keep: qm::SiteReport {
            holders: 1 << f,
            defender_present: false,
        },
        ..BellReport::default()
    };
    let out = qm::step(&mut a, 7, &rep, &prm()).unwrap();
    assert!(out.emits() && out.active);
    let pl = qm::conquest_payload(&a, &out).unwrap();
    assert_eq!(pl.n, 1);
    assert_eq!((pl.keep_contender, pl.keep_progress), (f, 1));
    assert_eq!(
        pl.records_digest,
        frontier_abi::v2::log::records_digest(&a).unwrap()
    );
    let back = frontier_abi::v2::log::ConquestPayload::from_bytes(&pl.to_bytes()).unwrap();
    assert_eq!(back, pl);
}
