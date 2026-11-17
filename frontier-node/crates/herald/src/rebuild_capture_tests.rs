//! Public literal bytes/PDA/hash only. No fixtures, apply, startup or Out IO.
use super::*;
use frontier_abi::layout::{header, player::citizen as C, province::province as P};

const WALLET: [u8; 32] = [9; 32];

fn cfg() -> FoldCfg {
    FoldCfg {
        program: Address::new_from_array([0x5e; 32]),
        season_id: 7,
        builder: Arc::new(crate::clash::Provisional),
        exact_post: true,
    }
}

fn rebuild(st: State) -> Fold {
    Fold::with_state(cfg(), Out::new("/dev/null/rebuild-inert"), st)
}

// Frozen pre-change traversal. Initialization has no accounts, so it cannot
// accidentally use the new traversal for any of the records under comparison.
fn old_rebuild(st: State) -> Fold {
    let mut f = rebuild(State::default());
    f.st = st;
    let all: Vec<([u8; 32], Vec<u8>)> =
        f.st.accounts
            .iter()
            .map(|(k, c)| (*k, c.data.clone()))
            .collect();
    for (k, d) in all {
        f.index_account(&k, &d);
    }
    f
}

fn data(magic: [u8; 8], size: usize) -> Vec<u8> {
    let mut d = vec![0; size];
    d[..8].copy_from_slice(&magic);
    d[8..16].copy_from_slice(&7u64.to_le_bytes());
    d[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    d
}

fn put(st: &mut State, key: [u8; 32], data: Vec<u8>, slot: u64) {
    st.accounts.insert(
        key,
        Capture {
            slot,
            tx: slot + 1,
            data,
        },
    );
}

fn province(first: u32) -> Vec<u8> {
    use frontier_abi::layout::province::entry as E;
    let mut d = data(P::MAGIC, P::SIZE);
    d[P::P..P::P + 2].copy_from_slice(&1i16.to_le_bytes());
    d[P::RING..P::RING + 2].copy_from_slice(&1u16.to_le_bytes());
    d[P::REGION] = 2;
    d[P::OPENED_BELL..P::OPENED_BELL + 4].copy_from_slice(&first.to_le_bytes());
    let host = frontier_abi::addr::host_id(1, 0, 2, 1, 3).unwrap();
    let at = P::entry(0);
    d[at + E::ID..at + E::ID + 8].copy_from_slice(&host.to_le_bytes());
    d[at + E::STATE] = 1;
    d
}

fn mixed() -> State {
    let mut st = State {
        last_slot: 999_999,
        folded_through: 88,
        events: 17,
        last_time: 1234,
        ..State::default()
    };
    let ctx = findex::addr_ctx(&cfg().program, 7);
    let mut citizen = data(C::MAGIC, C::SIZE);
    citizen[C::WALLET..C::WALLET + 32].copy_from_slice(&WALLET);
    citizen[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&17u64.to_le_bytes());
    citizen[C::HOLDINGS_N] = 1;
    citizen[C::HOLDING..C::HOLDING + 2].copy_from_slice(&1i16.to_le_bytes());
    citizen[C::HOLDING + 4] = 2;
    citizen[C::HOLDING + 5] = 1;
    put(&mut st, ctx.citizen(&WALLET), citizen, 31);
    // Reverse insertion, duplicate logical province: last sorted capture wins.
    put(&mut st, [250; 32], province(19), 91);
    put(&mut st, [2; 32], province(3), 11);
    let mut arrival = data(frontier_abi::layout::clash::arrival_slot::MAGIC, 48);
    arrival[40..48].copy_from_slice(&17u64.to_le_bytes());
    put(&mut st, [5; 32], arrival, 25);
    put(&mut st, [6; 32], P::MAGIC.to_vec(), 26); // truncated
    put(&mut st, [0; 32], vec![], 0);
    put(&mut st, [255; 32], vec![0; 8192], 100); // unknown, maximal key
    use frontier_abi::layout::world::season as S;
    put(&mut st, ctx.season, data(S::MAGIC, S::SIZE), 7);
    st.pending.insert(
        (1, 0, 9),
        Capture {
            slot: 12,
            tx: 13,
            data: province(3),
        },
    );
    st.ov_next.insert(1, 10);
    st.ring_seeds.insert(1, [4; 32]);
    st
}

fn parity(st: State) -> Fold {
    let before = crate::checkpoint::encode(&cfg().program.to_bytes(), 7, &st);
    let count = st.accounts.len();
    let total: usize = st.accounts.values().map(|c| c.data.len()).sum();
    let peak = st
        .accounts
        .values()
        .map(|c| c.data.len())
        .max()
        .unwrap_or(0);
    let old = old_rebuild(st.clone());
    let f = rebuild(st.clone());
    assert_eq!(f.st, st);
    assert_eq!(
        crate::checkpoint::encode(&cfg().program.to_bytes(), 7, &f.st),
        before
    );
    assert_eq!(f.provinces, old.provinces);
    assert_eq!(f.rings, old.rings);
    assert_eq!(f.regions, old.regions);
    assert_eq!(f.wallet_of, old.wallet_of);
    assert_eq!(f.season, old.season);
    let wallet = Address::new_from_array(WALLET);
    assert_eq!(
        crate::views::me_json(&f, &wallet, Value::Null),
        crate::views::me_json(&old, &wallet, Value::Null)
    );
    assert_eq!(
        crate::views::province_latest(&f, 1, 0),
        crate::views::province_latest(&old, 1, 0)
    );
    #[cfg(feature = "wide-world-experimental")]
    {
        let w = f.wide.as_ref().unwrap();
        let ow = old.wide.as_ref().unwrap();
        assert_eq!(w.stamp(), ow.stamp());
        assert_eq!(w.epoch(), ow.epoch());
        assert_eq!(w.refused(), ow.refused());
        assert_eq!(
            crate::wide::manifest_json(&f),
            crate::wide::manifest_json(&old)
        );
        assert_eq!(
            crate::wide::page_json(&f, None, Some(64)),
            crate::wide::page_json(&old, None, Some(64))
        );
    }
    assert_eq!(f.rebuild_copy.records, count);
    assert_eq!(f.rebuild_copy.total, total);
    assert_eq!(f.rebuild_copy.peak, peak);
    assert_eq!(f.rebuild_copy.current, 0);
    f
}

#[test]
fn restart_empty_and_mixed_captures_match_old_sorted_replay() {
    parity(State::default());
    let f = parity(mixed());
    assert_eq!(f.provinces[&(1, 0)].addr, [250; 32]);
    assert_eq!(f.provinces[&(1, 0)].first, 19);
    assert!(f.season.is_some());
    let v = crate::views::me_json(&f, &Address::new_from_array(WALLET), Value::Null);
    assert_eq!(v["hosts"].as_array().unwrap().len(), 2);
    assert_eq!(v["slots"].as_array().unwrap().len(), 1);
    assert_eq!(v["slots"][0]["slot"], 25);
}

#[test]
fn restart_source_copy_peak_does_not_grow_with_account_count() {
    let mut st = State::default();
    for n in (0..257u32).rev() {
        let mut key = [0; 32];
        key[..4].copy_from_slice(&n.to_be_bytes());
        put(&mut st, key, vec![0; 1024 + (n as usize % 3)], n as u64);
    }
    let f = parity(st);
    assert_eq!(f.rebuild_copy.peak, 1026);
    assert!(f.rebuild_copy.total > 256 * f.rebuild_copy.peak);
}

#[cfg(feature = "wide-world-experimental")]
#[test]
fn restart_wide_stamps_inventory_and_views_keep_capture_slots() {
    use frontier_abi::world_index::{holding, land, WideCoord};
    let base = rebuild(State::default());
    let world = base.wide.as_ref().unwrap().world();
    let mut st = mixed();
    let ca = base.ctx.citizen(&WALLET);
    let citizen = &mut st.accounts.get_mut(&ca).unwrap().data;
    citizen[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2]
        .copy_from_slice(&2u16.to_le_bytes());
    citizen[C::HOLDINGS_N] = 3;
    for slot in [2, 3] {
        let at = C::HOLDING + (slot - 1) * 6;
        citizen[at + 4] = 12;
        citizen[at + 5] = 0;
    }
    // Multiple coordinates/sites exercise both relative address orders of
    // province/holding replay, which affect report ordering and final stamps.
    let mut province_first = false;
    let mut holding_first = false;
    for n in 0..8 {
        let coord = WideCoord::checked(100_000 + n, 0).unwrap();
        let p = land::WideProvince {
            season_id: 7,
            world,
            coord,
            wedge: coord.wedge().unwrap(),
            region: 3,
            opened_bell: 5,
            readiness: land::readiness::REQUIRED,
            seed_round: 99,
            ring_seed: [7; 32],
            funded_lamports: 10,
        };
        let pa = land::province_address(&base.ctx, coord);
        let mut pd = vec![0; land::province::SIZE];
        p.write_identity(&mut pd).unwrap();
        put(&mut st, pa, pd, 101 + n as u64);
        for site in 0..3 {
            let h = holding::WideHolding {
                season_id: 7,
                world,
                coord,
                site,
                gen: 1,
                slot: if n == 0 && site == 0 { 3 } else { 2 },
                owner_citizen: ca,
                host_identity: 0,
                open_transits: 0,
            };
            let ha = holding::holding_address(&base.ctx, coord, site);
            province_first |= pa < ha;
            holding_first |= ha < pa;
            let mut hd = vec![0; holding::wide_holding::SIZE];
            h.write_identity(&mut hd).unwrap();
            put(&mut st, ha, hd, 201 + n as u64 * 3 + site as u64);
        }
    }
    assert!(province_first && holding_first);
    // Correct wide bytes at a wrong address must retain refusal behavior.
    let invalid = st
        .accounts
        .values()
        .find(|c| c.data.len() == land::province::SIZE)
        .unwrap()
        .data
        .clone();
    put(&mut st, [254; 32], invalid, 777);
    let f = parity(st.clone());
    assert_eq!(f.wide.as_ref().unwrap().refused(), 1);
    assert_eq!(f.wide.as_ref().unwrap().len(), 9);
    let inventory = crate::wide::holdings_for_citizen(&f, &ca);
    assert_eq!(inventory[0]["status"], "ambiguous");
    assert_eq!(inventory[1]["status"], "captured-unverified");
    let view = crate::views::me_json(&f, &Address::new_from_array(WALLET), Value::Null);
    assert_eq!(view["wideHoldings"], inventory);
    // Control proves parity would detect accidentally using last_slot.
    for c in st.accounts.values_mut() {
        c.slot = st.last_slot;
    }
    let wrong_slots = old_rebuild(st);
    assert_ne!(
        f.wide.as_ref().unwrap().stamp(),
        wrong_slots.wide.as_ref().unwrap().stamp()
    );
}
