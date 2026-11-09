//! Public literal bytes, in-memory selected handlers only. No Out methods,
//! signing, fixtures, Fold::apply, dispatch, or full season finalization.
use super::*;
use crate::files::Out;
use crate::fold::{Capture, FoldCfg};
use frontier_abi::layout::player::citizen as C;
use solana_address::Address;
use std::sync::Arc;

const WALLET: [u8; 32] = [9; 32];

fn fold(tag: Option<u64>) -> Fold {
    let mut f = Fold::new(
        FoldCfg {
            program: Address::new_from_array([0x5e; 32]),
            season_id: 7,
            builder: Arc::new(crate::clash::Provisional),
            exact_post: true,
        },
        Out::new("/dev/null/player-siege-index-inert"),
    );
    f.cq.on = true;
    if let Some(tag) = tag {
        let mut data = vec![0; C::SIZE];
        data[..8].copy_from_slice(&C::MAGIC);
        data[8..16].copy_from_slice(&7u64.to_le_bytes());
        data[C::WALLET..C::WALLET + 32].copy_from_slice(&WALLET);
        data[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&tag.to_le_bytes());
        f.st.accounts.insert(
            f.ctx.citizen(&WALLET),
            Capture {
                slot: 1,
                tx: 1,
                data,
            },
        );
        f.cq.tags.insert(tag, (WALLET, 1));
    }
    f
}

fn history(p: i32, declared: u32, owner: Option<u64>, attacker: u64) -> SiegeHistory {
    SiegeHistory {
        p,
        q: 0,
        site: 2,
        declared,
        kind: if owner.is_none() {
            SiegeKind::Free
        } else {
            SiegeKind::Other
        },
        owner,
        attacker,
        owner_faction: if owner.is_none() { 6 } else { 1 },
        attacker_faction: 2,
        required: 12,
        horn: RecordRef {
            kind: "siege_declared".into(),
            bell: declared,
            seq: 1,
            sig: "1111".into(),
            detail: json!({}),
        },
        series: vec![],
        end: None,
        followed: vec![],
    }
}

fn put(cq: &mut Cq, row: SiegeHistory) {
    cq.site_siege
        .insert((row.p as i16, row.q as i16, row.site), row.declared);
    cq.sieges
        .insert((row.p as i16, row.q as i16, row.site, row.declared), row);
}

// Frozen pre-index me_additions, including the original global history loop.
fn legacy(f: &Fold) -> Option<(Value, Value, Value)> {
    if !f.cq.on {
        return None;
    }
    let alerts = Value::Array(f.cq.alerts.get(&WALLET).cloned().unwrap_or_default());
    let tag = f
        .account(&me_citizen(f, &WALLET))
        .and_then(|c| rd_u64(&c.data, C::CITIZEN_TAG));
    let mut sieges = vec![];
    if let Some(tag) = tag {
        for t in f.cq.sieges.values().filter(|t| t.end.is_none()) {
            let role = if t.owner == Some(tag) {
                "owner"
            } else if t.attacker == tag {
                "attacker"
            } else {
                continue;
            };
            sieges.push(json!({
                "key": t.key(), "role": role, "p": t.p, "q": t.q, "site": t.site, "kind": t.kind.as_str(),
                "declared": t.declared, "required": t.required,
                "progress": t.series.last().map_or(0, |s| s.progress),
                "attackerFaction": t.attacker_faction, "ownerFaction": t.owner_faction,
            }));
        }
    }
    let player = tag
        .and_then(|t| Some((t, f.cq.players.get(&t)?, f.cq.faction_of_tag(t)?)))
        .map_or(Value::Null, |(t, c, fac)| {
            json!({"tag": tag_hex(t), "faction": fac, "keepsTaken": c[0], "keepBells": c[1],
                "siegesWon": c[2], "captures": c[3], "liberations": c[4]})
        });
    Some((alerts, Value::Array(sieges), player))
}

fn parity(f: &mut Fold) -> Value {
    assert_eq!(
        status_json(f)["sieges"],
        json!(f.cq.sieges.values().filter(|s| s.end.is_none()).count())
    );
    let old = legacy(f);
    player_siege_index::ROW_VISITS.with(|n| n.set(0));
    assert_eq!(me_additions(f, &WALLET), old);
    let expected_visits = old.as_ref().map_or(0, |x| x.1.as_array().unwrap().len());
    player_siege_index::ROW_VISITS.with(|n| assert_eq!(n.get(), expected_visits));
    let actual = crate::views::me_json(
        f,
        &Address::new_from_array(WALLET),
        json!({"remaining": 19}),
    );
    // All unchanged M1 fields use the actual view, with MC additions disabled;
    // reattach the independently frozen MC additions for full-response parity.
    let on = f.cq.on;
    f.cq.on = false;
    let mut expected = crate::views::me_json(
        f,
        &Address::new_from_array(WALLET),
        json!({"remaining": 19}),
    );
    f.cq.on = on;
    if let Some((alerts, sieges, player)) = old {
        let o = expected.as_object_mut().unwrap();
        o.insert("alerts".into(), alerts);
        o.insert("sieges".into(), sieges);
        o.insert("player".into(), player);
    }
    assert_eq!(actual, expected);
    actual
}

#[test]
fn active_siege_parity_order_replacement_progress_and_restore() {
    let mut f = fold(Some(17));
    for (p, owner, attacker) in [
        (9, Some(17), 17),
        (-3, Some(17), 22),
        (2, Some(22), 17),
        (4, None, 17),
    ] {
        put(&mut f.cq, history(p, 1, owner, attacker));
    }
    // Two simultaneous live declarations at a site both appeared in the old loop.
    put(&mut f.cq, history(-3, 2, Some(17), 22));
    f.cq.alerts.insert(WALLET, vec![json!({"kind": "example"})]);
    f.cq.players.insert(17, [1, 2, 3, 4, 5]);
    let before_growth = parity(&mut f);
    // Use 500 distinct provinces inside the deployed radius-128 world so
    // the existing legacy checkpoint parser can read every history.
    for i in 0..500 {
        let (p, q) = (20 + i % 100, i / 100);
        let mut unrelated = history(p, 1, Some(99), 100);
        unrelated.q = q;
        put(&mut f.cq, unrelated);
        let mut ended = history(p, 2, Some(17), 17);
        ended.q = q;
        ended.end = Some(SiegeEnd {
            bell: 3,
            outcome: SiegeOutcome::Failed,
            broken_by_defender: true,
            credited: None,
        });
        put(&mut f.cq, ended);
    }
    let v = parity(&mut f);
    assert_eq!(v, before_growth);
    assert_eq!(v["sieges"].as_array().unwrap().len(), 5);
    assert_eq!(v["sieges"][0]["p"], -3);
    assert_eq!(v["sieges"][1]["declared"], 2);
    assert_eq!(v["sieges"][4]["role"], "owner");
    f.cq.track_mut(-3, 0, 2).unwrap().series.push(SiegeBell {
        bell: 3,
        progress: 7,
        ..Default::default()
    });
    assert_eq!(parity(&mut f)["sieges"][1]["progress"], 7);
    // Exact-key replacement removes both former participant memberships.
    put(&mut f.cq, history(9, 1, Some(98), 99));
    assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 4);
    f.cq = f.cq.clone();
    parity(&mut f);
    let checkpoint = f.cq.to_json();
    assert_eq!(
        checkpoint["sieges"].as_array().unwrap().len(),
        f.cq.sieges.len()
    );
    f.cq = Cq::from_json(&checkpoint).unwrap();
    assert_eq!(f.cq.to_json(), checkpoint);
    parity(&mut f);
    // A repeated checkpoint key must use the final row's participants.
    let mut checkpoint = checkpoint;
    checkpoint["sieges"]
        .as_array_mut()
        .unwrap()
        .push(Value::String(
            history(-3, 2, Some(90), 91).to_json().unwrap(),
        ));
    f.cq = Cq::from_json(&checkpoint).unwrap();
    assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 3);
}

#[test]
fn active_siege_zero_free_missing_and_disabled() {
    let mut f = fold(Some(0));
    put(&mut f.cq, history(-1, 1, None, 19));
    put(&mut f.cq, history(0, 1, None, 0));
    put(&mut f.cq, history(1, 1, Some(0), 0));
    let v = parity(&mut f);
    assert_eq!(v["sieges"].as_array().unwrap().len(), 2);
    assert_eq!(v["sieges"][0]["role"], "attacker");
    assert_eq!(v["sieges"][1]["role"], "owner");
    f.st.accounts.clear();
    assert_eq!(parity(&mut f)["sieges"], json!([]));
    f.cq.on = false;
    assert!(parity(&mut f).get("sieges").is_none());
}

#[test]
fn active_siege_exact_map_order_and_active_ended_replacements() {
    let mut f = fold(Some(17));
    let key = (-20, 4, 2, 9);
    // The map key, not the history's p/declared or its printable key, orders
    // responses. Keep that property even for manually inserted histories.
    f.cq.sieges.insert(key, history(90, 1, Some(17), 17));
    put(&mut f.cq, history(1, 1, Some(17), 21));
    assert_eq!(parity(&mut f)["sieges"][0]["p"], 90);
    let mut ended = history(90, 1, Some(17), 17);
    ended.end = Some(SiegeEnd {
        bell: 4,
        outcome: SiegeOutcome::Lapsed,
        broken_by_defender: false,
        credited: None,
    });
    let old = f.cq.sieges.insert(key, ended.clone()).unwrap();
    assert!(old.end.is_none());
    assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 1);
    // Ended -> ended does not underflow the count or create memberships.
    f.cq.sieges.insert(key, ended);
    parity(&mut f);
    f.cq.sieges.insert(key, old);
    assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 2);
    f.cq.sieges.end(
        (99, 0, 2, 1),
        SiegeEnd {
            bell: 4,
            outcome: SiegeOutcome::Lapsed,
            broken_by_defender: false,
            credited: None,
        },
    );
    parity(&mut f);
    // Ending a site's latest declaration must leave an older still-live
    // history visible, just as the original complete-history scan did.
    put(&mut f.cq, history(1, 2, Some(17), 21));
    assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 3);
    f.cq.end_siege(
        1,
        0,
        2,
        SiegeEnd {
            bell: 4,
            outcome: SiegeOutcome::Failed,
            broken_by_defender: true,
            credited: None,
        },
    );
    assert!(f.cq.sieges[&(1, 0, 2, 1)].end.is_none());
    assert_eq!(
        f.cq.sieges[&(1, 0, 2, 2)].end.as_ref().unwrap().outcome,
        SiegeOutcome::Failed
    );
    let v = parity(&mut f);
    assert_eq!(v["sieges"].as_array().unwrap().len(), 2);
    assert_eq!(v["sieges"][1]["declared"], 1);
}

fn tx() -> TxRecord {
    TxRecord {
        seq: 1,
        slot: 1,
        signature: fclient::ports::Signature::from([1; 64]),
        block_time: 0,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

// Executes only SIEGE_DECLARED's selected fold_record match arm. Public field
// offsets construct the payload directly, not a transaction or signed record.
fn declare(f: &mut Fold, owner: u64, attacker: u64) {
    let kind = AnyKind::Cq(CqKind::SIEGE_DECLARED);
    let mut payload = vec![0u8; 256];
    for (name, bytes) in [
        ("owner_tag", owner.to_le_bytes().to_vec()),
        ("declarer_tag", attacker.to_le_bytes().to_vec()),
        ("owner_faction", vec![1]),
        ("attacker", vec![2]),
        ("required", vec![12]),
        (
            "target",
            vec![frontier_abi::v2::layout::province::conquest::TARGET_FIRST],
        ),
    ] {
        let (offset, width) = v2log::field(kind, name, true).unwrap();
        assert_eq!(width, bytes.len());
        payload[offset..offset + width].copy_from_slice(&bytes);
    }
    let key = [0, 0, 0, 0, 0, 0, 0, 0, 2];
    let r = v2log::Record {
        kind,
        bell: 1,
        key: &key,
        payload: &payload,
        body_without_tail: &[],
        links: [None; frontier_abi::log::MAX_LINKS],
        n_links: 0,
    };
    let mut cq = std::mem::take(&mut f.cq);
    fold_record(&mut cq, f, &tx(), CqKind::SIEGE_DECLARED, &r, 1, "1111");
    f.cq = cq;
}

#[test]
fn active_siege_selected_declaration_end_handlers_and_lapse() {
    for (code, outcome) in [
        (event::SIEGE_FAILED, SiegeOutcome::Failed),
        (event::OCCUPIED, SiegeOutcome::Occupied),
        (event::CAPTURE_DUE, SiegeOutcome::CaptureDue),
    ] {
        for detail in [false, true] {
            let mut f = fold(Some(17));
            declare(&mut f, 17, 21);
            assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 1);
            declare(&mut f, 19, 20); // actual replacement drops owner 17
            assert_eq!(parity(&mut f)["sieges"], json!([]));
            declare(&mut f, 17, 17); // duplicate participant: owner wins
            assert_eq!(parity(&mut f)["sieges"][0]["role"], "owner");
            let pl = ConquestPayload {
                events: [Event::default(); v2log::CONQUEST_EVENTS_MAX],
                n: 0,
                records_digest: [0; 32],
                keep_holder: 0,
                keep_contender: 0,
                keep_progress: 0,
                keep_troops: 0,
                donor_host_id: 0,
                snapshot: None,
            };
            let mut cq = std::mem::take(&mut f.cq);
            let e = Event {
                site: 2,
                code: code | if detail { event::DETAIL } else { 0 },
                faction: 2,
                progress: 12,
            };
            conquest_event(&mut cq, &mut f, &tx(), (0, 0), 2, &e, &pl, 2, "1111");
            let first = cq.sieges[&(0, 0, 2, 1)].end.clone().unwrap();
            assert_eq!(first.outcome, outcome);
            assert_eq!(
                first.broken_by_defender,
                outcome == SiegeOutcome::Failed && detail
            );
            assert_eq!(
                first.credited,
                (outcome == SiegeOutcome::CaptureDue).then_some(detail)
            );
            // A later different outcome must never overwrite the first end.
            conquest_event(
                &mut cq,
                &mut f,
                &tx(),
                (0, 0),
                3,
                &Event {
                    code: event::SIEGE_FAILED,
                    ..e
                },
                &pl,
                3,
                "1111",
            );
            assert_eq!(cq.sieges[&(0, 0, 2, 1)].end.as_ref(), Some(&first));
            f.cq = cq;
            assert_eq!(parity(&mut f)["sieges"], json!([]));
            put(&mut f.cq, history(-2, 1, Some(17), 22));
            // The exact pure mutation called in finalization, without its IO.
            let keys: Vec<_> = f.cq.sieges.keys().copied().collect();
            for key in keys {
                f.cq.sieges.end(
                    key,
                    SiegeEnd {
                        bell: 9,
                        outcome: SiegeOutcome::Lapsed,
                        broken_by_defender: false,
                        credited: None,
                    },
                );
            }
            assert_eq!(
                f.cq.sieges[&(-2, 0, 2, 1)].end.as_ref().unwrap().outcome,
                SiegeOutcome::Lapsed
            );
            assert_eq!(f.cq.sieges[&(0, 0, 2, 1)].end.as_ref(), Some(&first));
            assert_eq!(parity(&mut f)["sieges"], json!([]));
            // Reopening a previously ended exact key reindexes it.
            declare(&mut f, 17, 21);
            assert_eq!(parity(&mut f)["sieges"].as_array().unwrap().len(), 1);
        }
    }
}
