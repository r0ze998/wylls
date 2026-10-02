//! `cq_*`: ABI v2 offsets transcribed from the MC contract text (§5.2),
//! no-panic decoding of arbitrary bytes by every v2 decoder and model
//! (M1 §3.5), the v1/v2 staging (R-16: every v1 name keeps its value),
//! and a seeded random walk of quiet rosters with records and a keep
//! contest requiring resolve ≡ skip byte for byte (G11 at model level).

use frontier_abi::clash_model as cm;
use frontier_abi::conquest_model::{self as qm, Record, StepParams};
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, province as P, site as SM};
use frontier_abi::v2::layout::world::{join_shard as JS, march_state as MS, season as S};
use frontier_abi::v2::{ix, log, presets, tags::Ix};

#[test]
fn cq_offsets_match_the_contract_text() {
    let table: &[(&str, usize, usize)] = &[
        ("province.conquest", P::CONQUEST, 4_096),
        ("province.keep", P::KEEP, 4_480),
        ("province.snap", P::SNAP, 4_512),
        ("province.captures_by", P::CAPTURES_BY, 4_632),
        ("province.keeps_taken_by", P::KEEPS_TAKEN_BY, 4_644),
        ("province.rsv", P::RSV_CQ, 4_656),
        ("province.size", P::SIZE, 4_736),
        ("site.tier_next", SM::TIER_NEXT, 5),
        ("site.held_since_hour", SM::HELD_SINCE_HOUR, 6),
        ("site.tier_next_bell", SM::TIER_NEXT_BELL, 28),
        ("record.target", CR::TARGET, 5),
        ("record.vigil", CR::VIGIL_START_MIN, 6),
        ("record.bell", CR::BELL, 12),
        ("record.actor", CR::ACTOR, 16),
        ("record.src", CR::SRC, 24),
        ("keep.changes", KP::CHANGES, 6),
        ("keep.troops", KP::TROOPS, 8),
        ("keep.since_bell", KP::SINCE_BELL, 12),
        (
            "keep.consolidated_until_bell",
            KP::CONSOLIDATED_UNTIL_BELL,
            16,
        ),
        ("keep.contest_from_bell", KP::CONTEST_FROM_BELL, 20),
        ("keep.gen", KP::GEN, 24),
        ("keep.last_taken_from", KP::LAST_TAKEN_FROM, 28),
        ("holding.prev_owner_tag", H::PREV_OWNER_TAG, 1_248),
        ("holding.prev_gen", H::PREV_GEN, 1_256),
        ("holding.capture_flags", H::CAPTURE_FLAGS, 1_257),
        ("holding.captured_bell", H::CAPTURED_BELL, 1_260),
        ("holding.prev_home", H::PREV_HOME, 1_264),
        ("citizen.sieges_today", C::SIEGES_TODAY, 145),
        ("citizen.siege_day", C::SIEGE_DAY, 150),
        ("citizen.slots", C::SLOTS, 187),
        ("joinshard.extra_holdings", JS::EXTRA_HOLDINGS, 108),
        ("joinshard.captured_in", JS::CAPTURED_IN, 112),
        ("joinshard.captured_out", JS::CAPTURED_OUT, 116),
        ("joinshard.razed", JS::RAZED, 120),
        ("joinshard.outposts", JS::OUTPOSTS, 124),
        ("season.conquest", S::CONQUEST_PARAMS, 896),
        ("march.next_hour", MS::NEXT_HOUR, 72),
        ("march.controller", MS::CONTROLLER, 76),
        ("march.contested", MS::CONTESTED, 77),
        ("march.last_flip_hour", MS::LAST_FLIP_HOUR, 80),
        ("march.lost_hours", MS::LOST_HOURS, 84),
        ("march.weight", MS::WEIGHT, 88),
        ("march.dominion_bells", MS::DOMINION_BELLS, 116),
        ("march.control_hours", MS::CONTROL_HOURS, 140),
        ("march.captures", MS::CAPTURES, 164),
        ("march.rent_to", MS::RENT_TO, 176),
    ];
    for (name, got, want) in table {
        assert_eq!(got, want, "{name}");
    }
    use presets::cq_layout as L;
    let cq: &[(&str, usize, usize)] = &[
        ("heartland_max_ring", L::HEARTLAND_MAX_RING, 1),
        ("keep_bells", L::KEEP_BELLS, 4),
        ("keep_home_guard", L::KEEP_HOME_GUARD, 8),
        ("siege_stake_gold", L::SIEGE_STAKE_GOLD, 20),
        ("capture_credit_min_bells", L::CAPTURE_CREDIT_MIN_BELLS, 28),
        ("release_after_secs", L::RELEASE_AFTER_SECS, 60),
        ("dominion_per_hour", L::DOMINION_PER_HOUR, 64),
        ("outpost_close_bells", L::OUTPOST_CLOSE_BELLS, 72),
        ("retire_hosts", L::RETIRE_HOSTS, 74),
        ("relations", L::RELATIONS, 75),
        ("flags", L::FLAGS, 76),
        ("rsv", L::RSV, 77),
    ];
    for (name, got, want) in cq {
        assert_eq!(got, want, "conquest block {name}");
    }
}

/// R-16: Wave 1 is additive. Every v1 table the M1 program, fclient, the
/// JS vectors and the WASM hash read keeps its value.
#[test]
fn cq_v1_names_keep_their_values() {
    assert_eq!(frontier_abi::tags::Ix::ALL.len(), 50);
    assert_eq!(frontier_abi::layout::province::province::SIZE, 4_096);
    assert_eq!(frontier_abi::layout::AccountKind::ALL.len(), 17);
    assert_eq!(frontier_abi::error::FrontierError::ALL.len(), 62);
    assert_eq!(frontier_abi::ABI_VERSION, 1);
    assert_eq!(
        frontier_abi::presets::RULESET_HASH,
        permutation_rules::frontier::ruleset_hash(),
        "M1's RULESET_HASH (72c6b583…4bd9) unchanged"
    );
    assert_eq!(
        permutation_rules::frontier::clash::MAX_GARRISONS,
        12,
        "MAX_GARRISONS stays 12 (K-21, R-16)"
    );
    assert_eq!(
        frontier_abi::clash_model::INPUT_DOMAIN,
        b"PSF-CLASH-INPUT-v1"
    );
}

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

#[test]
fn cq_v2_decoders_never_panic_on_arbitrary_bytes() {
    let mut r = XorShift(0xC0FF_EE00_0000_0002);
    let prm = StepParams {
        genesis_ts: 1_788_998_400,
        end_bell: 1_008,
        cq: presets::MC_LOCAL_7D.cq,
    };
    for i in 0..20_000 {
        let len = r.below(480) as usize;
        let mut d = r.bytes(len);
        if !d.is_empty() && r.next() % 2 == 0 {
            d[0] = Ix::ALL[r.below(Ix::ALL.len() as u64) as usize].tag();
        }
        let _ = ix::tag_of(&d);
        let _ = ix::DeclareSiege::decode(&d);
        let _ = ix::SettleCapture::decode(&d);
        let _ = ix::FoldMarch::decode(&d);
        let _ = ix::FileOutpost::decode(&d);
        let _ = ix::CreateSeasonV2::decode(&d);
        let _ = presets::SeasonParamsV2::from_bytes(&d);
        let _ = presets::ConquestParams::from_bytes(&d);
        let _ = log::ConquestPayload::from_bytes(&d);
        if d.len() > 1 && r.next() % 2 == 0 {
            d[0] = 1;
            d[1] = 80 + r.below(10) as u8;
        }
        if let Ok(rec) = log::decode(&d) {
            let _ = log::chains_of(rec.kind, rec.key, rec.payload);
        }
        for k in log::CQ_SPECS {
            let kl = r.below(16) as usize;
            let key = r.bytes(kl);
            let _ = log::chains_of(log::AnyKind::Cq(k.kind), &key, &d);
        }
        // the models on garbage Provinces: errors, never panics
        if i % 20 == 0 {
            let mut pd = r.bytes(P::SIZE);
            let _ = qm::decode_records(&pd);
            let _ = qm::read_keep(&pd);
            let _ = qm::control_weights(&pd, r.next() as u32);
            let _ = qm::report_quiet(&pd, r.next() as u32);
            let _ = cm::trivially_quiet_v2(&pd, r.next() as u32);
            let _ = cm::build_v2(&pd, None, r.next() as u32);
            let rep = qm::BellReport::default();
            let _ = qm::step(&mut pd, r.next() as u32, &rep, &prm);
            let sl = r.below(4_736) as usize;
            let short = r.bytes(sl);
            let mut s2 = short.clone();
            let _ = qm::step(&mut s2, 3, &rep, &prm);
            let ms: [Option<&[u8]>; 7] = [Some(&short), None, Some(&pd), None, None, None, None];
            let _ = qm::fold(&ms, r.next() as u32);
        }
    }
}

/// G11 at model level over random quiet rosters: holdings and Free
/// Cities with empty garrisons, one faction per hex, sieges and
/// occupations on random sites and a keep contest; resolve ≡ skip after
/// every bell.
#[test]
fn cq_random_quiet_rosters_resolve_equals_skip() {
    use frontier_abi::addr::host_id;
    use frontier_abi::entry::{write_entry, Entry, EntryOp};
    use frontier_abi::layout::province::entry as E;
    use permutation_rules::frontier::clash::{frontier_ruleset, is_quiet, resolve_clash};
    use permutation_rules::frontier::geometry::ProvinceCoord;
    use permutation_rules::frontier::terrain::generate_province;

    let prm = StepParams {
        genesis_ts: 1_788_998_400,
        end_bell: 1_008,
        cq: presets::MC_TEST.cq,
    };
    let mut r = XorShift(0x5EED_0000_0000_00C1);
    let mut events = 0usize;
    for seed in 0..24u64 {
        let (p, q) = [(5, -1), (0, 6), (-4, 7), (3, 2), (-6, 2), (2, -7)][seed as usize % 6];
        let c = ProvinceCoord::new(p, q);
        let t = generate_province(&[seed as u8; 32], c);
        let mut pd = vec![0u8; P::SIZE];
        frontier_abi::v2::layout::write_header(
            &mut pd,
            frontier_abi::v2::layout::AccountKind::Province,
            1,
        );
        pd[P::P..P::P + 2].copy_from_slice(&(p as i16).to_le_bytes());
        pd[P::Q..P::Q + 2].copy_from_slice(&(q as i16).to_le_bytes());
        for i in 0..61 {
            pd[P::TERRAIN + i] = cm::TERRAINS
                .iter()
                .position(|x| *x == t.terrain[i])
                .unwrap() as u8;
        }
        pd[P::SITES..P::SITES + 12].copy_from_slice(&t.sites);
        pd[P::SITE_COUNT] = t.site_count;
        cm::Camp {
            tile: 0,
            state: 0,
            troops: 0,
            next_check_day: 1_000,
            gen: 0,
        }
        .write(&mut pd)
        .unwrap();
        let tile = frontier_abi::v2::kernel::keep::keep_tile(
            &t,
            &t.sites,
            t.site_count,
            c.wedge().unwrap(),
        )
        .unwrap();
        let mut kp = prm.cq.keep_params();
        kp.home_guard = 0;
        let k =
            frontier_abi::v2::kernel::keep::open(c, c.wedge().unwrap(), 2, tile, &kp, 0).unwrap();
        qm::write_keep(&mut pd, &k).unwrap();
        // one faction per tile (≤ 1 host per tile, ≤ 8 per faction)
        let mut tile_fac = [0xFFu8; 61];
        let mut per_f = [0u8; 6];
        let mut e_i = 0usize;
        let mut want_tiles: Vec<u8> = vec![tile];
        want_tiles.extend_from_slice(&t.sites[..t.site_count as usize]);
        for _ in 0..8 {
            want_tiles.push(r.below(61) as u8);
        }
        for &tl in &want_tiles {
            let f = r.below(6) as u8;
            if tile_fac[tl as usize] != 0xFF || per_f[f as usize] >= 8 || r.next() % 3 == 0 {
                continue;
            }
            tile_fac[tl as usize] = f;
            per_f[f as usize] += 1;
            let id = host_id(0, 4, (e_i % 12) as u8, 0, e_i as u32 + 1).unwrap();
            let unit = if r.next() % 7 == 0 { 6 } else { 0 }; // some Scouts
            write_entry(
                &mut pd,
                e_i,
                &Entry {
                    id,
                    faction: f,
                    unit,
                    tile: tl,
                    state: E::STATE_ROSTER,
                    troops: (100 + r.below(20_000) as u32) * 1_000,
                    stamina_value: 120,
                    dealt_bps: 10_000,
                    stamina_bell: 0,
                    ready_bell: 0,
                    from_bell: 0,
                    pend_bell: 0,
                    op: EntryOp::None,
                },
            )
            .unwrap();
            e_i += 1;
        }
        // sites: holdings / Free Cities with empty garrisons, records
        for s in 0..t.site_count as usize {
            let o = P::site(s);
            pd[o + SM::PEND0_BELL..o + SM::PEND0_BELL + 4]
                .copy_from_slice(&SM::NO_BELL.to_le_bytes());
            pd[o + SM::PEND1_BELL..o + SM::PEND1_BELL + 4]
                .copy_from_slice(&SM::NO_BELL.to_le_bytes());
            match r.below(3) {
                0 => continue,
                1 => {
                    pd[o + SM::STATE] = SM::STATE_HOLDING;
                    pd[o + SM::FACTION] = r.below(6) as u8;
                    pd[o + SM::ORDER] = 1 + r.below(3) as u8;
                    pd[o + SM::TIER] = r.below(4) as u8;
                }
                _ => {
                    pd[o + SM::STATE] = SM::STATE_FREE_CITY;
                    pd[o + SM::FACTION] = 6;
                }
            }
            let fc = pd[o + SM::STATE] == SM::STATE_FREE_CITY;
            let rec = match r.below(3) {
                0 => continue,
                1 => Record {
                    kind: CR::KIND_SIEGE,
                    faction: r.below(6) as u8,
                    flags: CR::FLAG_HELD | if fc { CR::FLAG_NEUTRAL } else { 0 },
                    progress: r.below(10) as u8,
                    required: 10 + r.below(20) as u8,
                    target: if fc {
                        CR::target(CR::TARGET_FREE_CITY, 2)
                    } else {
                        CR::target(1 + r.below(2) as u8, 0)
                    },
                    vigil_start: r.below(1_440) as u16,
                    bell: 0,
                    ..Record::ZERO
                },
                _ if !fc => Record {
                    kind: CR::KIND_OCCUPATION,
                    faction: r.below(6) as u8,
                    target: CR::target(CR::TARGET_FIRST, 0),
                    bell: 0,
                    ..Record::ZERO
                },
                _ => continue,
            };
            rec.write(&mut pd, s).unwrap();
        }
        let mut a = pd.clone();
        let mut sk = pd;
        for b in 1..60u32 {
            // resolve
            let built = cm::build_v2(&a, None, b).unwrap();
            let quiet = is_quiet(&frontier_ruleset(), &built.input(&[0; 32])).unwrap();
            assert!(quiet, "seed {seed} bell {b}");
            let out = resolve_clash(&frontier_ruleset(), &built.input(&[9; 32])).unwrap();
            let ap = cm::apply_v2(&mut a, &built, &out).unwrap();
            let rep_a = qm::report_from_outcome(&built, &out).unwrap();
            let st_a = cm::settle_bell(&mut a, b).unwrap();
            let oa = qm::step(&mut a, b, &rep_a, &prm).unwrap();
            cm::finish_bell(&mut a, b, ap.changed() || st_a || oa.roster_changed).unwrap();
            // skip
            let rep_s = qm::report_quiet(&sk, b).unwrap();
            assert_eq!(rep_a, rep_s, "seed {seed} bell {b}: reports");
            let st_s = cm::settle_bell(&mut sk, b).unwrap();
            let os = qm::step(&mut sk, b, &rep_s, &prm).unwrap();
            cm::finish_bell(&mut sk, b, st_s || os.roster_changed).unwrap();
            assert_eq!(oa, os, "seed {seed} bell {b}: steps");
            assert!(a == sk, "seed {seed} bell {b}: Provinces differ");
            events += oa.n as usize;
        }
    }
    assert!(events > 20, "the walk exercised the step ({events} events)");
}
