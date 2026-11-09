//! Actual host dispatch over literal gathered arrivals, not lifecycle setup.
//! Seeds and public identities are synthetic. No signing or native crypto.
use super::*;

fn combat_accounts(committed: u32, pending: i64, walls: bool) -> Vec<AccountInfo<'static>> {
    let a = fixture();
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV::SITE_COUNT] = 1;
        pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
            frontier_abi::v2::layout::province::keep::NO_TILE;
        put(&mut pd, PV2::SCORE_NEXT_BELL, &10u32.to_le_bytes());
        put(&mut pd, PV::CAMP + CP::NEXT_CHECK_DAY, &1u32.to_le_bytes());
        put(
            &mut pd,
            PV::site(0) + SM::GARRISON,
            &committed.to_le_bytes(),
        );
        put(
            &mut pd,
            PV::site(0) + SM::WALLS_COMMITTED,
            &(walls as u32).to_le_bytes(),
        );
    }
    if pending != 0 {
        exec(&a, &data(pending)).unwrap();
    }
    let mut ra = resolve_accounts(&a, 10);
    let h = WideHolding::read(&a[4].try_borrow_data().unwrap()).unwrap();
    let pk = ProvinceKey::new(h.world, h.coord);
    let ctx = crate::addr::ctx(&a[2].key.to_bytes(), &PROGRAM);
    let mut day = wa::WideArrivalDay::new(SEASON_ID, pk, 0, PAYER);
    assert!(day.set(10));
    let mut db = vec![0; wa::wide_arrival_day::SIZE];
    day.write(&mut db).unwrap();
    let mut hdr = wa::WideClashInputsHdr::new(SEASON_ID, pk, 10, PAYER);
    hdr.n_present = 1;
    hdr.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    let mut cd = vec![0; wa::wide_clash_inputs::SIZE];
    hdr.write(&mut cd).unwrap();
    wa::WideArrival {
        host: WideHostRef::new(
            ProvinceKey::new(h.world, WideCoord::checked(130, 0).unwrap()),
            0,
            2,
            1,
        )
        .unwrap(),
        citizen: [0x46; 32],
        dep_mass: 100_000,
        troops: 100_000,
        stamina: 61,
        retreat_bps: 0,
        dealt_bps: 10_000,
        faction: 1,
        unit: 0,
        // The parent fixture stores site 0 on tile 0 (plain grassland).
        // Resolve reads those stored bytes, not regenerated terrain.
        tile: a[5].try_borrow_data().unwrap()[PV::SITES],
        stance: 0,
        present: true,
        fate: 0,
        troops_after: 0,
    }
    .write_at(&mut cd, 4)
    .unwrap();
    ra[6] = info(
        leak(wa::clash_inputs_address(&ctx, pk, 10), PROGRAM, cd, 0, BIG),
        false,
        true,
    );
    ra[7] = info(
        leak(wa::arrival_day_address(&ctx, pk, 0), PROGRAM, db, 0, BIG),
        false,
        false,
    );
    ra
}

fn fight(a: &[AccountInfo<'static>]) -> (u32, wa::WideArrival, u32) {
    at_bell(12);
    exec(
        a,
        &wix::Resolve {
            bell: 10,
            beneficiary: PAYER,
        }
        .to_bytes(),
    )
    .unwrap();
    let pd = a[2].try_borrow_data().unwrap();
    assert_eq!(Ro(&pd).u32(PV::RESOLVED_NEXT).unwrap(), 11);
    assert_eq!(Ro(&pd).i64(PV::site(0) + SM::PEND0_DELTA).unwrap(), 0);
    let cd = a[6].try_borrow_data().unwrap();
    let hdr = wa::WideClashInputsHdr::read(&cd).unwrap();
    assert_ne!(hdr.flags & wa::wide_clash_inputs::FLAG_RESOLVED, 0);
    assert_eq!(hdr.resolver, PAYER);
    let arrival = wa::WideArrival::read_at(&cd, 4).unwrap().unwrap();
    let engagements = Ro(&pd).u32(PV::RESOLVE_SUMMARY + SU::ENGAGEMENTS).unwrap();
    assert_eq!(Ro(&pd).u8(PV::RESOLVE_SUMMARY + SU::ARRIVALS).unwrap(), 1);
    assert_eq!(
        WideRecord::decode(WIDE_LOGS.lock().unwrap().last().unwrap())
            .unwrap()
            .kind,
        WideKind::Resolve
    );
    (
        Ro(&pd).u32(PV::site(0) + SM::GARRISON).unwrap(),
        arrival,
        engagements,
    )
}

#[test]
fn hostile_arrival_cannot_fight_same_bell_reinforcement() {
    let _g = begin();
    let base = fight(&combat_accounts(0, 0, false));
    let reinforced = fight(&combat_accounts(0, 20, false));
    assert_eq!(base.0, 0);
    assert_eq!(reinforced.0, 20_000);
    assert_eq!(base.1, reinforced.1);
    assert_eq!(base.2, reinforced.2);
    assert_eq!(reinforced.1.troops_after, 100_000);
}

#[test]
fn committed_garrison_fights_and_walls_change_real_casualties() {
    let _g = begin();
    let open = fight(&combat_accounts(100_000, 0, false));
    let walls = fight(&combat_accounts(100_000, 0, true));
    let pending = fight(&combat_accounts(100_000, 20, false));
    eprintln!(
        "garrison/attacker milli-troops: open={}/{}, walls={}/{}, pending={}/{}; engagements={}",
        open.0,
        open.1.troops_after,
        walls.0,
        walls.1.troops_after,
        pending.0,
        pending.1.troops_after,
        open.2
    );
    assert!(open.2 > 0);
    assert!(open.0 < 100_000);
    assert!(open.1.troops_after < 100_000);
    assert!(walls.0 > open.0, "walls must protect the garrison");
    assert_eq!(pending.0, open.0 + 20_000);
    assert_eq!(pending.1, open.1);
    assert_eq!(pending.2, open.2);
}
