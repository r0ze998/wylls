//! In-memory, public-byte tests only. No fixtures, dispatch, signing or IO.
use super::*;
use crate::views::me_json;
use fclient::decode::{Citizen, Holding};
use frontier_abi::addr::{holding_key_of_host, host_id};
use frontier_abi::layout::{
    header,
    player::citizen as C,
    province::{entry as E, province as P},
};
use std::sync::atomic::Ordering::Relaxed;

const WALLET: [u8; 32] = [9; 32];
const TAG: u64 = 17;

fn fold() -> Fold {
    Fold::new(
        FoldCfg {
            program: Address::new_from_array([0x5e; 32]),
            season_id: 7,
            builder: Arc::new(crate::clash::Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/player-host-index-inert"),
    )
}

fn data(magic: [u8; 8], size: usize) -> Vec<u8> {
    let mut d = vec![0; size];
    d[..8].copy_from_slice(&magic);
    d[8..16].copy_from_slice(&7u64.to_le_bytes());
    d
}

// Exactly the capture replacement/close index hooks, without Fold::apply's
// event dispatch or file output. No test calls an Out IO method.
fn put(f: &mut Fold, address: [u8; 32], d: Vec<u8>) {
    f.st.accounts.insert(
        address,
        Capture {
            slot: 42,
            tx: 3,
            data: d.clone(),
        },
    );
    f.index_account(&address, &d);
}

fn close(f: &mut Fold, address: [u8; 32]) {
    let old = f.st.accounts.get(&address).unwrap().data.clone();
    f.unindex_account(&address, &old);
    f.st.accounts.remove(&address);
}

fn citizen(f: &mut Fold, refs: &[(i16, u8)], version: u16) -> [u8; 32] {
    let mut d = data(C::MAGIC, C::SIZE);
    d[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&version.to_le_bytes());
    d[C::WALLET..C::WALLET + 32].copy_from_slice(&WALLET);
    d[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&TAG.to_le_bytes());
    d[C::HOLDINGS_N] = refs.len() as u8;
    for i in 0..3 {
        d[C::HOLDING + i * 6 + 5] = 255;
    }
    for (i, (p, gen)) in refs.iter().enumerate() {
        let at = C::HOLDING + i * 6;
        d[at..at + 2].copy_from_slice(&p.to_le_bytes());
        d[at + 4] = 2;
        d[at + 5] = *gen;
    }
    let address = f.ctx.citizen(&WALLET);
    put(f, address, d);
    address
}

fn host(p: i32, n: u32) -> u64 {
    host_id(p, 0, 2, 1, n).unwrap()
}

fn province(p: i16, entries: &[(u64, u8)]) -> Vec<u8> {
    let mut d = data(P::MAGIC, P::SIZE);
    d[P::P..P::P + 2].copy_from_slice(&p.to_le_bytes());
    // N_ENTRIES deliberately remains zero: the old view walks all storage.
    for (i, (id, state)) in entries.iter().enumerate() {
        let at = P::entry(i);
        d[at + E::ID..at + E::ID + 8].copy_from_slice(&id.to_le_bytes());
        d[at + E::STATE] = *state;
        d[at + E::FACTION] = 3;
        d[at + E::UNIT] = 2;
        d[at + E::TILE] = i as u8;
        d[at + E::TROOPS..at + E::TROOPS + 4].copy_from_slice(&123u32.to_le_bytes());
        d[at + E::READY_BELL..at + E::READY_BELL + 4].copy_from_slice(&7u32.to_le_bytes());
        d[at + E::FROM_BELL..at + E::FROM_BELL + 4].copy_from_slice(&6u32.to_le_bytes());
    }
    d
}

fn arrival(tag: u64) -> Vec<u8> {
    let mut d = data(frontier_abi::layout::clash::arrival_slot::MAGIC, 48);
    d[40..48].copy_from_slice(&tag.to_le_bytes());
    d
}

fn parity(f: &Fold) -> Value {
    let wallet = Address::new_from_array(WALLET);
    let quota = json!({"remaining": 19});
    let actual = me_json(f, &wallet, quota.clone());
    assert_eq!(actual, legacy_me_json(f, &wallet, quota));
    actual
}

#[test]
fn player_host_output_parity_preserves_order_duplicates_transits_seals_and_short_slots() {
    use frontier_abi::layout::player::{holding as H, transit as T};
    let mut f = fold();
    let ca = citizen(&mut f, &[(1, 1), (2, 1), (1, 1)], 1);
    let mut h = data(H::MAGIC, H::SIZE);
    h[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(&ca);
    h[H::TRANSIT + T::STATE] = 1;
    h[H::TRANSIT + T::HOST_ID..H::TRANSIT + T::HOST_ID + 8]
        .copy_from_slice(&host(1, 3).to_le_bytes());
    let ha = f.ctx.holding(1, 0, 2);
    put(&mut f, ha, h);
    put(
        &mut f,
        [30; 32],
        province(-5, &[(host(2, 8), 2), (host(1, 9), 1)]),
    );
    put(
        &mut f,
        [20; 32],
        province(8, &[(host(1, 3), 1), (host(1, 3), 1), (host(2, 1), 0)]),
    );
    put(&mut f, [13; 32], arrival(TAG));
    put(&mut f, [12; 32], arrival(TAG));
    f.st.accounts.get_mut(&[12; 32]).unwrap().slot = 99;
    put(&mut f, [11; 32], arrival(TAG)[..47].to_vec());
    f.st.seals.insert(
        host(1, 3),
        SealRec {
            outcome: 2,
            code: 4,
            bell: 6,
        },
    );
    let v = parity(&f);
    assert_eq!(v["hosts"].as_array().unwrap().len(), 4);
    assert_eq!(v["hosts"][0]["province"], json!([8, 0]));
    assert_eq!(v["hosts"][2]["id"], host(2, 8).to_string());
    assert_eq!(v["slots"].as_array().unwrap().len(), 2);
    assert_eq!(v["slots"][0]["slot"], 99);
    assert_eq!(v["transits"].as_array().unwrap().len(), 2);
    assert_eq!(v["seals"].as_array().unwrap().len(), 2);
}

#[test]
fn player_host_lookup_work_is_independent_of_unrelated_world_captures() {
    let mut f = fold();
    citizen(&mut f, &[(1, 1)], 1);
    put(&mut f, [20; 32], province(0, &[(host(1, 1), 1)]));
    put(&mut f, [21; 32], arrival(TAG));
    let expected = parity(&f);
    for i in 0..512u32 {
        let mut address = [200; 32];
        address[..4].copy_from_slice(&i.to_le_bytes());
        put(&mut f, address, province(99, &[(host(2, i), 1)]));
        address[4] = 201;
        put(&mut f, address, arrival(TAG + 1));
        address[4] = 202;
        put(
            &mut f,
            address,
            data(frontier_abi::layout::player::holding::MAGIC, 1280),
        );
    }
    f.player_hosts.host_reads.store(0, Relaxed);
    f.player_hosts.arrival_reads.store(0, Relaxed);
    assert_eq!(parity(&f), expected);
    assert_eq!(f.player_hosts.host_reads.load(Relaxed), 1);
    assert_eq!(f.player_hosts.arrival_reads.load(Relaxed), 1);
}

#[test]
fn player_host_replace_close_malformed_and_restart_match_scan() {
    let mut f = fold();
    citizen(&mut f, &[(1, 1)], 1);
    let address = [20; 32];
    let original = province(0, &[(host(1, 1), 1)]);
    put(&mut f, address, original.clone());
    let expected = parity(&f);
    put(&mut f, address, original.clone());
    assert_eq!(parity(&f), expected);
    for replacement in [
        province(5, &[(host(2, 1), 1)]),
        original[..80].to_vec(),
        arrival(TAG),
        arrival(TAG + 1),
        arrival(TAG)[..47].to_vec(),
        vec![0; 16],
        original,
    ] {
        put(&mut f, address, replacement);
        let expected = parity(&f);
        f = Fold::with_state(f.cfg.clone(), f.out.clone(), f.st.clone());
        assert_eq!(parity(&f), expected);
    }
    close(&mut f, address);
    assert_eq!(parity(&f)["hosts"], json!([]));
    put(&mut f, address, arrival(TAG));
    close(&mut f, address);
    assert_eq!(parity(&f)["slots"], json!([]));
    assert_eq!(
        f.player_hosts.hosts(&[holding_key_of_host(host(1, 0))]),
        Vec::<Value>::new()
    );
}

#[test]
fn player_host_missing_citizen_empty_refs_and_cq_rejected_holding_keep_old_gates() {
    use frontier_abi::layout::player::holding as H;
    let mut f = fold();
    put(&mut f, [20; 32], province(0, &[(host(1, 1), 1)]));
    put(&mut f, [21; 32], arrival(TAG));
    assert_eq!(parity(&f)["hosts"], json!([]));
    citizen(&mut f, &[], 1);
    assert_eq!(parity(&f)["slots"], json!([]));
    citizen(&mut f, &[(1, 1)], 2);
    let mut h = data(H::MAGIC, H::SIZE);
    h[H::GEN] = 2; // CQ ownership/gen rejection occurs after host-key collection.
    let ha = f.ctx.holding(1, 0, 2);
    put(&mut f, ha, h);
    let v = parity(&f);
    assert_eq!(v["holdings"], json!([]));
    assert_eq!(v["hosts"].as_array().unwrap().len(), 1);
    assert_eq!(v["slots"].as_array().unwrap().len(), 1);
}

#[test]
fn player_host_zero_tag_and_duplicate_ids_across_capture_addresses_match_scan() {
    let mut f = fold();
    let ca = citizen(&mut f, &[(1, 1)], 1);
    let mut ci = f.account(&ca).unwrap().data.clone();
    ci[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].fill(0);
    put(&mut f, ca, ci);
    for address in [[20; 32], [30; 32]] {
        put(&mut f, address, province(0, &[(host(1, 1), 1)]));
    }
    put(&mut f, [21; 32], arrival(0));
    let v = parity(&f);
    assert_eq!(v["hosts"].as_array().unwrap().len(), 2);
    assert_eq!(v["slots"].as_array().unwrap().len(), 1);
    put(&mut f, [20; 32], province(0, &[]));
    assert_eq!(parity(&f)["hosts"].as_array().unwrap().len(), 1);
}

#[cfg(feature = "wide-world-experimental")]
#[test]
fn player_host_wide_interception_indexes_surviving_capture_only() {
    use fclient::ports::{Account, Signature};
    use frontier_abi::layout::player::holding as H;
    use frontier_abi::world_index::{holding, WideCoord};
    use holding::wide_holding as W;
    let mut f = fold();
    let ca = citizen(&mut f, &[(1, 1)], 1);
    let coord = WideCoord::checked(129, 0).unwrap();
    let key = holding::holding_address(&f.ctx, coord, 2);
    let mut d = data(W::MAGIC, W::SIZE);
    d[header::LAYOUT_VERSION..header::LAYOUT_VERSION + 2].copy_from_slice(&3u16.to_le_bytes());
    d[W::FAMILY_VERSION..W::FAMILY_VERSION + 2].copy_from_slice(&1u16.to_le_bytes());
    d[W::STATUS] = W::STATUS_FOUNDED;
    d[W::SLOT] = 2;
    d[H::SITE] = 2;
    d[H::GEN] = 1;
    d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(&ca);
    d[W::WORLD..W::WORLD + 32].copy_from_slice(f.wide.as_ref().unwrap().world().as_bytes());
    d[W::SORT_KEY..W::SORT_KEY + 17].copy_from_slice(&coord.sort_key());
    let tx = TxRecord {
        seq: 12,
        slot: 34,
        signature: Signature::from([0; 64]),
        block_time: 0,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    };
    for legacy in [province(0, &[(host(1, 1), 1)]), arrival(TAG)] {
        put(&mut f, key, legacy.clone());
        let expected = parity(&f);
        let mut account = Account {
            owner: Address::new_from_array([0; 32]),
            data: d.clone(),
            lamports: 1,
            executable: false,
        };
        assert!(f.capture_wide_post(&key, Some(&account), &tx));
        assert_eq!(parity(&f), expected); // Refused owner retains legacy rows.
        account.owner = f.cfg.program;
        account.data.truncate(16);
        assert!(f.capture_wide_post(&key, Some(&account), &tx));
        assert_eq!(parity(&f), expected); // Refused malformed wide data also retains them.
        account.data = d.clone();
        assert!(f.capture_wide_post(&key, Some(&account), &tx));
        assert_ne!(f.account(&key).unwrap().data, legacy);
        let v = parity(&f);
        assert_eq!(v["hosts"], json!([]));
        assert_eq!(v["slots"], json!([]));
        assert!(f.capture_wide_post(&key, None, &tx));
        assert!(f.account(&key).is_none());
        parity(&f);
    }
}

// Frozen full-scan implementation from the base revision, apart from using
// the public account_json wrapper for its identical private acct helper.
fn legacy_me_json(f: &Fold, wallet: &Address, quota: Value) -> Value {
    let ca = crate::conquest::me_citizen(f, &wallet.to_bytes());
    let citizen = f.account(&ca).and_then(|c| Citizen::decode(&c.data).ok());
    let mut holdings = vec![];
    let mut keys = vec![];
    let mut transits = vec![];
    if let Some(ci) = &citizen {
        let cq = ci.h.layout_version >= 2;
        for (slot, s) in ci.holding.iter().enumerate().filter(|(slot, s)| {
            if cq {
                s.gen != 255
            } else {
                *slot < ci.holdings_n.min(3) as usize
            }
        }) {
            let _ = slot;
            let ha = f.ctx.holding(s.p as i32, s.q as i32, s.site);
            if let Some(hk) = host_id(s.p as i32, s.q as i32, s.site, s.gen, 0) {
                keys.push(holding_key_of_host(hk));
            }
            if let Some(h) = f.account(&ha).and_then(|c| Holding::decode(&c.data).ok()) {
                if cq && (h.gen != s.gen || h.owner_citizen.to_bytes() != ca) {
                    continue;
                }
                holdings.push(crate::views::account_json(f, &ha));
                for (i, t) in h.transit.iter().enumerate().filter(|(_, t)| t.state != 0) {
                    transits.push(json!({
                        "holding": [s.p, s.q, s.site], "transitSlot": i, "state": t.state,
                        "host": t.host_id.to_string(), "departBell": t.depart_bell, "arriveBell": t.arrive_bell,
                        "sealRoot": hex::encode(t.seal_root), "tip": t.tip.to_string(),
                    }));
                }
            }
        }
    }
    let mut hosts = vec![];
    let mut slots = vec![];
    if !keys.is_empty() {
        for c in f.st.accounts.values() {
            match c
                .data
                .get(..8)
                .and_then(|m| AccountKind::from_magic(m.try_into().ok()?))
            {
                Some(AccountKind::Province) => {
                    let Ok(pv) = Province::decode(&c.data) else {
                        continue;
                    };
                    for e in pv.entries.iter().filter(|e| e.state != 0) {
                        if keys.contains(&holding_key_of_host(e.id)) {
                            hosts.push(json!({
                                "id": e.id.to_string(), "province": [pv.p, pv.q], "state": e.state,
                                "faction": e.faction, "unit": e.unit, "tile": e.tile, "troops": e.troops,
                                "readyBell": e.ready_bell, "fromBell": e.from_bell,
                            }));
                        }
                    }
                }
                Some(AccountKind::ArrivalSlot) => {
                    let tag = citizen.as_ref().map(|c| c.citizen_tag);
                    let st = c
                        .data
                        .get(40..48)
                        .map(|b| u64::from_le_bytes(b.try_into().unwrap_or_default()));
                    if tag.is_some() && st == tag {
                        let key =
                            crate::records::account_key(AccountKind::ArrivalSlot, &c.data, "");
                        slots.push(
                            json!({"key": key, "slot": c.slot, "bytes_b64": B64.encode(&c.data)}),
                        );
                    }
                }
                _ => {}
            }
        }
    }
    let mut seals = vec![];
    for k in &keys {
        for (h, s) in f.st.seals.range(*k..=(*k | 0xFFFF_FFFF)) {
            seals.push(json!({"host": h.to_string(), "outcome": s.outcome, "code": s.code, "bell": s.bell}));
        }
    }
    let mut v = json!({
        "v": 1,
        "wallet": wallet.to_string(),
        "citizen": crate::views::account_json(f, &ca),
        "holdings": holdings,
        "hosts": hosts,
        "transits": transits,
        "slots": slots,
        "seals": seals,
        "quota": quota,
        "latestSlot": f.st.last_slot,
    });
    #[cfg(feature = "wide-world-experimental")]
    {
        // The viewer's wide inventory, kept apart from `holdings` (never a
        // legacy Holding at (0,0)): the identity envelope every entry is
        // checked against, then the slots. Both additive; a page reads them
        // together or not at all.
        v["wideContext"] = crate::wide::context_for_citizen(f, &ca);
        v["wideHoldings"] = crate::wide::holdings_for_citizen(f, &ca);
    }
    // MC (CQ2-E, §8.4): `alerts[]`, `sieges[]` and the caller's players
    // row; an M1 season's answer is unchanged.
    if let (Some((alerts, sieges, player)), Some(o)) = (
        crate::conquest::me_additions(f, &wallet.to_bytes()),
        v.as_object_mut(),
    ) {
        o.insert("alerts".into(), alerts);
        o.insert("sieges".into(), sieges);
        o.insert("player".into(), player);
    }
    v
}
