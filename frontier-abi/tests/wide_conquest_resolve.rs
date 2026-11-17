#![cfg(feature = "world-index-experimental")]
//! Literal public identities/terrain/bell seeds only. No fixture exporters,
//! private keys, signing, subprocesses, or native crypto.
use frontier_abi::bytes::{rd_u16, rd_u32, rd_u64, wr_u32};
use frontier_abi::clash_model::{Camp, DAY_BELLS};
use frontier_abi::conquest_model::{
    read_keep, snapshot_slot, write_keep, Record, SiteRecordRules, SiteTransitionMirror, StepParams,
};
use frontier_abi::entry::{unit_to_u8, write_entry, Entry, EntryOp};
use frontier_abi::layout::province::{entry as E, province as P, site as SM};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as SM2};
use frontier_abi::v2::presets::FRONTIER_7;
use frontier_abi::world_index::{
    conquest::{WideConquest, WideConquestEntry},
    land::{province as L, readiness, WideProvince},
    march::WideCombatant,
    resolve::{self, ResolveError, Unported, WideConquestBellOutcome},
    roster::{wide_roster, WideRoster},
    ProvinceKey, WideCoord, WideHostRef, WorldId,
};
use permutation_rules::frontier::clash::{frontier_ruleset, Fate, NEUTRAL};
use permutation_rules::frontier::host::STAMINA_CAP;
use permutation_rules::frontier::keep::{Keep, NO_FACTION};
use permutation_rules::units::UnitType;

const START: u32 = 598;
const SEASON: u64 = 19;
const CITY: usize = 0;
const TILE: u8 = 1;

fn key() -> ProvinceKey {
    ProvinceKey::new(
        WorldId::new([7; 32]).unwrap(),
        WideCoord::checked((1i64 << 54) + 1, -129).unwrap(),
    )
}
fn host() -> WideHostRef {
    WideHostRef::new(key(), 3, 8, 7).unwrap()
}
fn params() -> StepParams {
    StepParams {
        genesis_ts: 0,
        end_bell: 10_000,
        cq: FRONTIER_7,
    }
}

struct Fixture {
    pd: Vec<u8>,
    roster: WideRoster,
    rd: Vec<u8>,
    table: Vec<u8>,
}
impl Fixture {
    fn new(troops: u32, garrison: u32) -> Self {
        let key = key();
        let mut pd = vec![0; L::SIZE];
        WideProvince {
            season_id: SEASON,
            world: key.world(),
            coord: key.coord(),
            wedge: key.coord().wedge().unwrap(),
            region: 3,
            opened_bell: START,
            readiness: readiness::REQUIRED,
            seed_round: 1,
            ring_seed: [0x51; 32],
            funded_lamports: 0,
        }
        .write_identity(&mut pd)
        .unwrap();
        // All-zero terrain is literal Grassland, no resource. Four distinct sites.
        pd[P::SITE_COUNT] = 4;
        pd[P::SITES..P::SITES + 4].copy_from_slice(&[1, 2, 3, 4]);
        assert!(wr_u32(&mut pd, P::RESOLVED_NEXT, START));
        assert!(wr_u32(&mut pd, P2::SCORE_NEXT_BELL, START));
        for s in 0..P::SITES_N {
            let o = P::site(s);
            pd[o + SM::FACTION] = NEUTRAL;
            assert!(wr_u32(&mut pd, o + SM::PEND0_BELL, SM::NO_BELL));
            assert!(wr_u32(&mut pd, o + SM::PEND1_BELL, SM::NO_BELL));
        }
        let o = P::site(CITY);
        pd[o + SM::STATE] = SM2::STATE_FREE_CITY;
        assert!(wr_u32(&mut pd, o + SM::GARRISON, garrison));
        assert!(wr_u32(&mut pd, o + SM::WALLS_COMMITTED, 101));
        assert!(wr_u32(&mut pd, o + SM::SHIELD_UNTIL_BELL, 777));
        Camp {
            tile: 0,
            state: 0,
            troops: 0,
            next_check_day: START / DAY_BELLS + 10,
            gen: 0,
        }
        .write(&mut pd)
        .unwrap();
        write_keep(
            &mut pd,
            &Keep {
                tile: 10,
                holder: 4,
                contender: NO_FACTION,
                progress: 0,
                required: 72,
                heartland_safe: false,
                paused: false,
                changes: 0,
                troops: 100,
                since_bell: START,
                consolidated_until_bell: 0,
                contest_from_bell: 0,
                gen: 0,
                last_taken_from: NO_FACTION,
            },
        )
        .unwrap();
        let roster = WideRoster::new(SEASON, key, [9; 32]);
        let mut rd = vec![0; wide_roster::SIZE];
        roster.write_header(&mut rd).unwrap();
        let alias = roster.claim(&mut rd, 0, &host()).unwrap();
        write_entry(
            &mut pd,
            0,
            &Entry {
                id: alias,
                faction: 1,
                unit: unit_to_u8(UnitType::Knight),
                tile: TILE,
                state: E::STATE_ROSTER,
                troops,
                stamina_value: STAMINA_CAP,
                dealt_bps: 0,
                stamina_bell: 0,
                ready_bell: 0,
                from_bell: 0,
                pend_bell: 0,
                op: EntryOp::None,
            },
        )
        .unwrap();
        let entry = WideConquestEntry {
            rules: SiteRecordRules {
                kind: CR::KIND_SIEGE,
                faction: 1,
                flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
                required: 2,
                target: CR::target(CR::TARGET_FREE_CITY, 2),
                bell: START,
                ..Default::default()
            },
            citizen: [8; 32],
            actor_tag: frontier_abi::addr::citizen_tag(&[8; 32]),
            source: Some(WideHostRef::new(key, 3, 8, 0).unwrap()),
            reserved_slot: 2,
            original_target_gen: 0,
            declaration_bell: START,
        };
        let plan = WideConquest::new(SEASON, key, [9; 32])
            .unwrap()
            .declare(
                0,
                Record::ZERO,
                SiteTransitionMirror {
                    state: SM2::STATE_FREE_CITY,
                    walls_committed: 101,
                    ..Default::default()
                },
                entry,
            )
            .unwrap();
        plan.prefix.write(&mut pd, CITY).unwrap();
        Self {
            pd,
            roster,
            rd,
            table: plan.conquest.to_bytes().to_vec(),
        }
    }
    fn bell(&mut self, bell: u32) -> Result<WideConquestBellOutcome, ResolveError> {
        let out = resolve::resolve_bell_with_conquest(
            &mut self.pd,
            &self.roster,
            &mut self.rd,
            &self.table,
            None,
            bell,
            &[0x63; 32],
            &frontier_ruleset(),
            &params(),
        )?;
        self.table = out.conquest.to_bytes().to_vec();
        Ok(out)
    }
    fn rejects_without_effect(&mut self, bell: u32) {
        let before = (self.pd.clone(), self.rd.clone(), self.table.clone());
        assert!(self.bell(bell).is_err());
        assert_eq!(
            (&self.pd, &self.rd, &self.table),
            (&before.0, &before.1, &before.2)
        );
    }
    fn paired(&self) {
        self.roster
            .validate_paired(&self.rd, &resolve::live_ids(&self.pd).unwrap())
            .unwrap();
        let table = WideConquest::read(&self.table, SEASON, key()).unwrap();
        for s in 0..P::SITES_N {
            table
                .validate_paired(s as u8, Record::read(&self.pd, s).unwrap())
                .unwrap();
        }
    }
}

#[test]
fn real_neutral_clash_progress_capture_and_next_bell_keep_full_identity() {
    let mut f = Fixture::new(20_000_000, 100_000);
    let initial = WideConquest::read(&f.table, SEASON, key())
        .unwrap()
        .entry(0)
        .unwrap()
        .unwrap();
    let city_id = WideCombatant::Host(WideHostRef::new(key(), 0, 0, 0).unwrap());
    let first = f.bell(START).unwrap();
    assert!(first.bell.clash.engagements > 0);
    let gr = first
        .bell
        .clash
        .garrisons
        .iter()
        .find(|g| g.id == city_id)
        .unwrap();
    assert_eq!(first.site_reports[0].holders, gr.holders);
    assert_eq!(first.site_reports[0].defender_present, gr.defender_present);
    assert_eq!(gr.holders, 1 << 1);
    assert!(gr.attackers_hold);
    assert_eq!(first.conquest.entry(0).unwrap().unwrap().rules.progress, 0);
    assert!(!first.records_changed && !first.mirrors_changed);
    f.paired();
    let second = f.bell(START + 1).unwrap();
    assert_eq!(second.conquest.entry(0).unwrap().unwrap().rules.progress, 1);
    assert!(second.records_changed && !second.mirrors_changed);
    assert!(second.site_events.is_empty());
    f.paired();
    let third = f.bell(600).unwrap();
    let due = third.conquest.entry(0).unwrap().unwrap();
    assert_eq!(due.rules.kind, CR::KIND_CAPTURE_DUE);
    assert_eq!(due.source, initial.source);
    assert_eq!(due.citizen, initial.citizen);
    assert_eq!(due.declaration_bell, START);
    assert_eq!(due.rules.bell, 600);
    assert_eq!(due.prefix().src, 0);
    assert_eq!(third.site_events.len(), 1);
    assert_eq!(third.site_events[0].site, 0);
    assert!(third.records_changed && third.mirrors_changed);
    let o = P::site(0);
    assert_eq!(
        (
            f.pd[o + SM::STATE],
            f.pd[o + SM::GEN],
            f.pd[o + SM::ORDER],
            f.pd[o + SM::FACTION]
        ),
        (SM::STATE_HOLDING, 1, 2, 1)
    );
    assert_eq!(rd_u32(&f.pd, o + SM::GARRISON), Some(0));
    assert_eq!(rd_u32(&f.pd, o + SM::PEND0_BELL), Some(SM::NO_BELL));
    assert_eq!(rd_u32(&f.pd, o + SM::PEND1_BELL), Some(SM::NO_BELL));
    assert_eq!(rd_u64(&f.pd, o + SM::PEND0_DELTA), Some(0));
    assert_eq!(rd_u64(&f.pd, o + SM::PEND1_DELTA), Some(0));
    assert_eq!(rd_u32(&f.pd, o + SM::SHIELD_UNTIL_BELL), Some(0));
    assert_eq!(rd_u32(&f.pd, o + SM::WALLS_COMMITTED), Some(50));
    assert_eq!(rd_u16(&f.pd, o + SM2::HELD_SINCE_HOUR), Some(101));
    assert_eq!(f.pd[o + SM2::TIER_NEXT], SM2::NO_TIER_NEXT);
    assert_eq!(rd_u16(&f.pd, P2::captures_by(1)), Some(1));
    assert_eq!(rd_u32(&f.pd, P::RESOLVED_NEXT), Some(601));
    assert_eq!(rd_u32(&f.pd, P2::SCORE_NEXT_BELL), Some(601));
    assert_eq!(rd_u64(&f.pd, P2::TERRITORY_BELLS + 8 * 4), Some(3));
    assert_eq!(read_keep(&f.pd).unwrap().unwrap().holder, 4);
    let snapshot = third.bell.step.snapshot.unwrap();
    assert_eq!(snapshot[NEUTRAL as usize], 0);
    assert!(snapshot[1] > 0);
    assert_eq!(snapshot_slot(&f.pd, 100).unwrap(), Some(snapshot));
    f.paired();
    let fourth = f.bell(601).unwrap();
    assert_eq!(fourth.conquest.entry(0).unwrap(), Some(due));
    assert!(!fourth.records_changed && !fourth.mirrors_changed);
    assert!(fourth.site_events.is_empty());
    assert_eq!(rd_u16(&f.pd, P2::captures_by(1)), Some(1));
    f.paired();
}

#[test]
fn actual_defeat_burns_source_but_preserves_slot_and_declaration() {
    let mut f = Fixture::new(1_000, 20_000_000);
    let first = f.bell(START).unwrap();
    assert!(first.bell.clash.engagements > 0);
    assert_eq!(
        first
            .bell
            .clash
            .fighter(&WideCombatant::Host(host()))
            .unwrap()
            .fate,
        Fate::Destroyed
    );
    let out = f.bell(START + 1).unwrap();
    assert_eq!(out.site_reports[0].holders, 0);
    let e = out.conquest.entry(0).unwrap().unwrap();
    assert_eq!(e.rules.kind, CR::KIND_NONE);
    assert_eq!(e.rules.flags, CR::FLAG_SLOT_OWED);
    assert_eq!(e.rules.required, 2);
    assert_eq!(e.source, None);
    assert_eq!(e.declaration_bell, START);
    assert_eq!(e.citizen, [8; 32]);
    assert_eq!(out.site_events.len(), 1);
    assert!(!out.mirrors_changed);
    assert_eq!(f.pd[P::site(0) + SM::STATE], SM2::STATE_FREE_CITY);
    let expected = Some(ResolveError::Unported(Unported::ConquestRecord(
        CR::KIND_NONE,
    )));
    let before = (f.pd.clone(), f.rd.clone(), f.table.clone());
    assert_eq!(
        resolve::build(&f.pd, &f.roster, &f.rd, None, 600).err(),
        expected
    );
    assert_eq!(
        resolve::step(&mut f.pd, &f.roster, &mut f.rd, 600, None, &params()).err(),
        expected
    );
    assert_eq!(
        resolve::resolve_bell(
            &mut f.pd,
            &f.roster,
            &mut f.rd,
            None,
            600,
            &[0x63; 32],
            &frontier_ruleset(),
            &params()
        )
        .err(),
        expected
    );
    assert_eq!((&f.pd, &f.rd, &f.table), (&before.0, &before.1, &before.2));
    f.paired();
    let next = f.bell(600).unwrap();
    assert_eq!(next.conquest.entry(0).unwrap(), Some(e));
    assert!(!next.records_changed);
    f.paired();
}

#[test]
fn exact_cursor_rejects_early_late_and_repeat_bells_without_effect() {
    let mut f = Fixture::new(20_000_000, 100_000);
    f.rejects_without_effect(START - 1);
    f.rejects_without_effect(START + 1);
    f.bell(START).unwrap();
    f.rejects_without_effect(START);
    f.rejects_without_effect(START + 2);
}

#[test]
fn report_uses_real_clash_before_settle_removes_the_attacker() {
    let mut f = Fixture::new(20_000_000, 100_000);
    f.bell(START).unwrap();
    f.pd[P::entry(0) + E::PEND_OP] = E::OP_FORFEIT;
    assert!(wr_u32(&mut f.pd, P::entry(0) + E::PEND_BELL, START + 1));
    let out = f.bell(START + 1).unwrap();
    assert_eq!(out.site_reports[0].holders, 1 << 1);
    assert_eq!(out.conquest.entry(0).unwrap().unwrap().rules.progress, 1);
    assert_eq!(f.roster.ref_at(&f.rd, 0).unwrap(), None);
    assert!(out.bell.settled);
    f.paired();
    let out = f.bell(600).unwrap();
    assert_eq!(out.site_reports[0].holders, 0);
    assert_eq!(
        out.conquest.entry(0).unwrap().unwrap().rules.flags,
        CR::FLAG_SLOT_OWED
    );
    f.paired();
}

#[test]
fn table_headers_full_context_duplicates_prefix_and_mirrors_fail_atomically() {
    for case in 0..17 {
        let mut f = Fixture::new(20_000_000, 100_000);
        match case {
            0 => f.table[8] ^= 1,                      // Season
            1 => f.table[33] ^= 1,                     // world/key bytes
            2 => f.table[81] ^= 1,                     // coordinate/key bytes
            3 => f.table[128 + 32..128 + 64].fill(0),  // incomplete Citizen/source context
            4 => f.table[128 + 48..128 + 104].fill(0), // missing full source
            5 => {
                let e = f.table[128..256].to_vec();
                f.table[256..384].copy_from_slice(&e);
            }
            6 => f.pd[P2::record(0) + CR::ACTOR] ^= 1,
            7 => f.pd[P2::record(0) + CR::SRC] = 1,
            8 => f.pd[P::site(0) + SM::GEN] = 1,
            9 => f.pd[P::site(0) + SM::STATE] = SM::STATE_HOLDING,
            10 => f.pd[P::SITE_COUNT] = 0,
            11 => f.pd[P::site(0) + SM::FACTION] = 1,
            12 => f.pd[P::site(0) + SM::ORDER] = 1,
            13 => {
                f.table = WideConquest::new(SEASON, key(), [9; 32])
                    .unwrap()
                    .to_bytes()
                    .to_vec();
            }
            14 => f.pd[P2::record(1) + CR::FLAGS] = CR::FLAG_SLOT_OWED,
            15 => {
                // Build/clash/apply/settle run on scratch, then the skipped
                // territory cursor fails. Caller bytes must still be intact.
                assert!(wr_u32(&mut f.pd, P::RESOLVED_NEXT, START + 1));
            }
            16 => f.rd[8] ^= 1,
            _ => unreachable!(),
        }
        f.rejects_without_effect(if case == 15 { START + 1 } else { START });
    }
}

#[test]
fn old_apis_refuse_active_and_capture_due_and_leave_data_unchanged() {
    let mut f = Fixture::new(20_000_000, 100_000);
    for kind in [CR::KIND_SIEGE, CR::KIND_CAPTURE_DUE] {
        let b = rd_u32(&f.pd, P::RESOLVED_NEXT).unwrap();
        let expected = Some(ResolveError::Unported(Unported::ConquestRecord(kind)));
        let before = (f.pd.clone(), f.rd.clone(), f.table.clone());
        assert_eq!(
            resolve::build(&f.pd, &f.roster, &f.rd, None, b).err(),
            expected
        );
        assert_eq!(
            resolve::step(&mut f.pd, &f.roster, &mut f.rd, b, None, &params()).err(),
            expected
        );
        assert_eq!(
            resolve::resolve_bell(
                &mut f.pd,
                &f.roster,
                &mut f.rd,
                None,
                b,
                &[0x63; 32],
                &frontier_ruleset(),
                &params()
            )
            .err(),
            expected
        );
        assert_eq!((&f.pd, &f.rd, &f.table), (&before.0, &before.1, &before.2));
        if kind == CR::KIND_SIEGE {
            for b in START..=600 {
                f.bell(b).unwrap();
            }
        }
    }
}

#[test]
fn canonical_prefix_immunity_is_preserved_but_legacy_and_split_stay_closed() {
    let mut f = Fixture::new(20_000_000, 100_000);
    let immunity = Record {
        faction: CR::BARRED_ALL,
        bell: 999,
        ..Record::ZERO
    };
    immunity.write(&mut f.pd, 1).unwrap();
    f.bell(START).unwrap();
    assert_eq!(Record::read(&f.pd, 1).unwrap(), immunity);
    for op in [E::OP_SPLIT, E::OP_ABSORB, E::OP_ABSORBED_INTO] {
        f.pd[P::entry(0) + E::PEND_OP] = op;
        f.rejects_without_effect(START + 1);
    }
    f.pd[P::entry(0) + E::PEND_OP] = E::OP_NONE;
    f.pd[P::entry(0) + E::ID..P::entry(0) + E::ID + 8].copy_from_slice(&1u64.to_le_bytes());
    f.rejects_without_effect(START + 1);
}

#[test]
fn initial_city_scope_and_canonical_holding_generation_are_distinct() {
    let mut f = Fixture::new(20_000_000, 100_000);
    // An unrelated existing Holding generation 254 remains representable.
    let o = P::site(1);
    f.pd[o + SM::STATE] = SM::STATE_HOLDING;
    f.pd[o + SM::GEN] = 254;
    f.pd[o + SM::ORDER] = 2;
    f.pd[o + SM::FACTION] = 3;
    for b in START..=600 {
        f.bell(b).unwrap();
    }
    f.paired();
    // A self-consistent non-initial-city capture is still outside this slice.
    f.table[128 + 113] = 1;
    f.pd[P::site(0) + SM::GEN] = 2;
    f.rejects_without_effect(601);
}

#[test]
fn old_build_preserves_canonical_no_obligation_immunity() {
    let mut f = Fixture::new(20_000_000, 100_000);
    let immunity = Record {
        faction: CR::BARRED_ALL,
        bell: 900,
        ..Record::ZERO
    };
    immunity.write(&mut f.pd, 0).unwrap();
    assert!(resolve::build(&f.pd, &f.roster, &f.rd, None, START).is_ok());
    assert_eq!(Record::read(&f.pd, 0).unwrap(), immunity);
}
