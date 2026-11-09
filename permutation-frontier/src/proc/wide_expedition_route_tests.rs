//! Literal public accounts and arithmetic only. Route-stage tests, not a
//! commitment/window/admission test or evidence that public crossing is enabled.
use super::*;
use alloc::boxed::Box;
use frontier_abi::v2::layout::write_header;
use permutation_rules::frontier::geometry::ProvinceCoord;

const PROGRAM: [u8; 32] = [0x12; 32];
const SID: u64 = 11;
const GENESIS: i64 = 1_800_000_000;
const NOW: i64 = GENESIS + 6000;
const ALL: u64 = (1u64 << 61) - 1;

fn ai(key_: [u8; 32], owner: [u8; 32], d: Vec<u8>) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(key_))),
        false,
        false,
        Box::leak(Box::new(1_000_000_000)),
        Box::leak(d.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}
struct Fixture {
    season: AccountInfo<'static>,
    holding: AccountInfo<'static>,
    external: AccountInfo<'static>,
    provinces: Vec<AccountInfo<'static>>,
    plain: WidePlain,
    origin: TileAddress,
    steps: Vec<TileAddress>,
    keys: Vec<ProvinceKey>,
}
impl Fixture {
    fn inspect(&self) -> R<RouteCost> {
        inspect(
            &Pubkey::new_from_array(PROGRAM),
            &self.season,
            &self.holding,
            &self.external,
            0,
            &self.plain,
            &self.provinces,
        )
    }
    fn legacy(&self) -> usize {
        self.keys
            .iter()
            .position(|k| k.coord().ring() <= 128)
            .unwrap()
    }
    fn structure(&self, kind: u8, faction: u8) {
        let i = self.legacy();
        let tile = self
            .steps
            .iter()
            .find(|t| t.key() == self.keys[i])
            .unwrap()
            .local();
        self.provinces[i].try_borrow_mut_data().unwrap()[TE::at(0)..TE::at(0) + 4]
            .copy_from_slice(&[kind, tile, faction, 1]);
    }
    fn snapshot(&self) -> Vec<(u64, Vec<u8>, Pubkey)> {
        [&self.season, &self.holding, &self.external]
            .into_iter()
            .chain(self.provinces.iter())
            .map(|a| {
                (
                    a.lamports(),
                    a.try_borrow_data().unwrap().to_vec(),
                    *a.owner,
                )
            })
            .collect()
    }
}
fn fixture() -> Fixture {
    prologue::set_test_clock(NOW, 1);
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 0, 1, 0).unwrap())
        .unwrap();
    let origin = TileAddress::new(host.key(), 30).unwrap();
    let mut tile = WideTile::of(origin);
    let mut path = [0; ks::PATH_BYTES];
    for i in 0..16 {
        ks::set_path_step(&mut path, i, 0);
        tile = tile.neighbors()[0].unwrap();
    }
    assert!(tile.province_coord().ring() > 128);
    let plain = WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: 20,
        dest: tile.province(),
        dest_tile: tile.local(),
        stance: 0,
        retreat_bps: 0,
        path_len: 16,
        path,
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    let (steps, keys) = path_tiles(&plain, origin).unwrap();
    assert!(keys.iter().any(|k| k.coord().ring() <= 128));
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, GENESIS).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    let bridge = BridgeTransit::new(
        &ctx,
        0,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            0,
            0,
            origin,
            10,
            20,
            NOW,
            200_000,
            super::super::super::host::DEPART_STAMINA,
            10_000,
            [0x31; 32],
            0,
            0,
            [0xa1; 32],
        )
        .unwrap(),
    )
    .unwrap();
    let marker = BridgeMarker::new(
        &ctx,
        &bridge,
        2500,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    Rw(&mut hd).set_i16(H::P, 128).unwrap();
    hd[H::GEN] = 1;
    hd[H::STATE] = H::STATE_FINAL;
    Rw(&mut hd).set_u32(H::HOST_SEQ, 1).unwrap();
    hd[H::transit(0)..H::transit(0) + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    let hk = resolver.holding_address(&host).unwrap();
    let provinces = keys
        .iter()
        .map(|key_| {
            let mut d = if key_.coord().ring() <= 128 {
                let mut d = vec![0; K2::Province.size()];
                assert!(write_header(&mut d, K2::Province, SID));
                Rw(&mut d).set_i16(PV::P, key_.coord().p() as i16).unwrap();
                Rw(&mut d).set_i16(PV::Q, key_.coord().q() as i16).unwrap();
                d
            } else {
                let mut d = vec![0; wl::province::SIZE];
                WideProvince {
                    season_id: SID,
                    world: key_.world(),
                    coord: key_.coord(),
                    wedge: key_.coord().wedge().unwrap(),
                    region: 0,
                    opened_bell: 1,
                    readiness: wl::readiness::REQUIRED,
                    seed_round: 1,
                    ring_seed: [0x52; 32],
                    funded_lamports: 0,
                }
                .write_identity(&mut d)
                .unwrap();
                d
            };
            Rw(&mut d).set_u64(PV::PASSABLE_MASK, ALL).unwrap();
            ai(resolver.province_address(*key_).unwrap(), PROGRAM, d)
        })
        .collect();
    Fixture {
        season: ai(sk, PROGRAM, sd),
        holding: ai(hk, PROGRAM, hd),
        external: ai(
            wm::transit_address(&ctx, &hk, 0),
            PROGRAM,
            bridge.to_bytes().to_vec(),
        ),
        provinces,
        plain,
        origin,
        steps,
        keys,
    }
}

#[test]
fn original_and_wide_accounts_form_one_read_only_route() {
    let f = fixture();
    let before = f.snapshot();
    let cost = f.inspect().unwrap();
    assert_eq!(cost.raw_secs, 16 * FLAT_HEX_SECS);
    assert_eq!(cost.watched_secs, 0);
    assert_eq!(
        cost.travel_secs,
        of_faction_v3(0).unwrap().travel_secs(cost.raw_secs as u64) as u32
    );
    assert_eq!(f.snapshot(), before);
}

#[test]
fn legacy_tower_watch_matches_deployed_kernel_for_roads_rough_and_mounts() {
    let f = fixture();
    f.structure(structures::KIND_TOWER, 1);
    for ai in &f.provinces {
        let mut d = ai.try_borrow_mut_data().unwrap();
        Rw(&mut d).set_u64(PV::ROUGH_MASK, ALL).unwrap();
        Rw(&mut d).set_u64(PV::ROAD_MASK, ALL).unwrap();
    }
    let ctx = addr::ctx(&key(&f.season), &PROGRAM);
    let stances = super::super::super::structure::stances_of(&f.season.try_borrow_data().unwrap());
    let lands: Vec<_> = f
        .keys
        .iter()
        .zip(&f.provinces)
        .map(|(k, a)| {
            land(
                &Pubkey::new_from_array(PROGRAM),
                &ctx,
                SID,
                *k,
                a,
                &stances,
                0,
                false,
                20,
            )
            .unwrap()
        })
        .collect();
    let watched: Vec<_> = lands
        .iter()
        .map(|l| structures::WatchedLand {
            at: ProvinceCoord::new(l.key.coord().p() as i32, l.key.coord().q() as i32),
            rough: l.rough,
            road: l.road,
            watch: l.watch,
        })
        .collect();
    for cavalry in [false, true] {
        let got = walk(&f.steps, &lands, cavalry).unwrap();
        let expected = structures::march_watch(
            (ProvinceCoord::new(128, 0), 30),
            &f.plain.path,
            16,
            &watched,
            cavalry,
        )
        .unwrap();
        assert_eq!(expected, structures::Walked::Secs(got.1));
        assert!(got.1 > 0);
        assert_eq!(got.0, 16 * (ROUGH_HEX_SECS >> (1 + cavalry as u32)));
    }
    assert!(f.inspect().unwrap().wear_bps > 0);
}

#[test]
fn stance_and_expulsion_use_actual_season_and_current_holding_flags() {
    let f = fixture();
    f.structure(structures::KIND_TOWER, 1);
    assert!(f.inspect().unwrap().watched_secs > 0);
    f.season.try_borrow_mut_data().unwrap()
        [crate::layout::season2::STANCES + structures::NATIONS] = structures::STANCE_ALLY;
    assert_eq!(f.inspect().unwrap().watched_secs, 0);
    f.structure(structures::KIND_TOWER, 0);
    assert_eq!(f.inspect().unwrap().watched_secs, 0);
    f.holding.try_borrow_mut_data().unwrap()[H::FLAGS] |=
        frontier_abi::v2::layout::player::holding::FLAG_EXPELLED;
    assert!(f.inspect().unwrap().watched_secs > 0);
}

#[test]
fn legacy_palisade_blocks_but_unported_wide_structures_refuse() {
    let f = fixture();
    f.structure(structures::KIND_PALISADE, 1);
    let before = f.snapshot();
    assert_eq!(f.inspect(), Err(FrontierError::Path.into()));
    assert_eq!(f.snapshot(), before);
    let f = fixture();
    f.provinces[0].try_borrow_mut_data().unwrap()[TE::at(0)] = structures::KIND_TOWER;
    assert_eq!(f.inspect(), Err(FrontierError::NotImplemented.into()));
    let f = fixture();
    let fr = frontier_abi::v2::layout::province::fort_record::at(0);
    f.provinces[0].try_borrow_mut_data().unwrap()
        [fr + frontier_abi::v2::layout::province::fort_record::STATE] = 1;
    assert_eq!(f.inspect(), Err(FrontierError::NotImplemented.into()));
}

#[test]
fn wrong_family_order_owner_writability_and_extra_accounts_fail_closed() {
    for case in 0..6 {
        let mut f = fixture();
        match case {
            0 => f.provinces.swap(0, 1),
            1 => f.provinces.push(f.provinces[0].clone()),
            2 => f.provinces[0].is_writable = true,
            3 => {
                let i = f.legacy();
                let d = f.provinces[i].try_borrow_data().unwrap().to_vec();
                let ctx = addr::ctx(&key(&f.season), &PROGRAM);
                f.provinces[i] = ai(wl::province_address(&ctx, f.keys[i].coord()), PROGRAM, d);
            }
            4 => {
                let k = key(&f.provinces[0]);
                let d = f.provinces[0].try_borrow_data().unwrap().to_vec();
                f.provinces[0] = ai(k, [0x77; 32], d);
            }
            _ => f.external = ai(key(&f.external), PROGRAM, vec![0; 304]),
        }
        let before = f.snapshot();
        assert!(f.inspect().is_err());
        assert_eq!(f.snapshot(), before);
    }
}

#[test]
fn previous_generation_uses_durable_pair_but_terminal_season_refuses() {
    let f = fixture();
    {
        let mut h = f.holding.try_borrow_mut_data().unwrap();
        h[H::GEN] = 2;
        Rw(&mut h).set_u32(H::HOST_SEQ, 0).unwrap();
    }
    assert!(f.inspect().is_ok());
    f.season.try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ABORTED;
    assert!(f.inspect().is_err());
}

#[test]
fn plaintext_world_destination_direction_and_padding_are_validated() {
    for case in 0..5 {
        let mut f = fixture();
        match case {
            0 => {
                f.plain.dest = ProvinceKey::new(
                    world_of(&addr::ctx(&[0x45; 32], &PROGRAM)).unwrap(),
                    f.plain.dest.coord(),
                )
            }
            1 => f.plain.dest = f.origin.key(),
            2 => ks::set_path_step(&mut f.plain.path, 0, 6),
            3 => f.plain.path[11] = 1,
            _ => f.plain.path_len = 0,
        }
        let before = f.snapshot();
        assert!(f.inspect().is_err());
        assert_eq!(f.snapshot(), before);
    }
}

#[test]
fn malformed_inactive_wide_forts_never_look_empty() {
    use frontier_abi::v2::layout::province::fort_record as FR;
    for (offset, value) in [(FR::STATE, 2), (FR::TROOPS, 1), (FR::PEND_BELL, 0xff)] {
        let f = fixture();
        f.provinces[0].try_borrow_mut_data().unwrap()[FR::at(0) + offset] = value;
        let before = f.snapshot();
        assert_eq!(f.inspect(), Err(BAD_ACCOUNT));
        assert_eq!(f.snapshot(), before);
    }
}

#[test]
fn route_stage_keeps_legacy_reveal_lifecycle_eligibility() {
    for state in 0..4 {
        let f = fixture();
        let ctx = addr::ctx(&key(&f.season), &PROGRAM);
        let initial =
            BridgeTransit::from_bytes(&ctx, &f.external.try_borrow_data().unwrap()).unwrap();
        let next = match state {
            0 => initial,
            1 => initial
                .step(
                    &ctx,
                    MarchEvent::SettleDeparture { destroyed: false },
                    Some((200_000, 40, 1)),
                )
                .unwrap(),
            2 => initial
                .step(
                    &ctx,
                    MarchEvent::SettleDeparture { destroyed: true },
                    Some((0, 0, 1)),
                )
                .unwrap(),
            _ => initial
                .step(
                    &ctx,
                    MarchEvent::SettleDeparture { destroyed: false },
                    Some((200_000, 40, 1)),
                )
                .unwrap()
                .step(&ctx, MarchEvent::Gather { dest: f.plain.dest }, None)
                .unwrap(),
        };
        f.external
            .try_borrow_mut_data()
            .unwrap()
            .copy_from_slice(&next.to_bytes());
        let before = f.snapshot();
        // Legacy states1..3 are all in_transit, including destroyed, and
        // gathered is a flag. Full Reveal still owns latch/window/admission.
        assert!(f.inspect().is_ok());
        assert_eq!(f.snapshot(), before);
    }
}
