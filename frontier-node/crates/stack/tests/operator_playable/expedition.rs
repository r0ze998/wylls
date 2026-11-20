//! P10 (devnet-expedition-keeper; devnet runbook gaps P10 + P13): a RIM → WIDE EXPEDITION on a devnet wide season,
//! offline, on the exact devnet `.so`, driven by keeper A after the player's ExpeditionDepart.
//!
//! After P5's world (the operator's setup; keeper A seeding the season, opening the rim's provinces and, with
//! `wide_rings` 1, the wide ring 129 on a SHIPPED round), with keeper A configured as the devnet profile now says
//! (P8's play roles plus **`expeditions`**):
//!
//! 1. REAL, a test participant: Join and a one-site rim FileTicket beside a ring-129 province keeper A opened; keeper
//!    A's `tickets` role settles it; the clock past `final_ts`; Harvest flips it final.
//! 2. **Declared patch**: 400 Spearmen in the village's reserve (as P6/P8).
//! 3. REAL, keeper A's `skip`: the home resolved so that Muster is resident; REAL, the participant: Muster 400 onto the
//!    home tile its route into ring 129 starts from (the program's own passable masks, `expedition_steps::
//!    derive_route`).
//! 4. REAL, the participant: ONE **ExpeditionDepart** (the 0x4804 wrapper, kind 0; the page's 「境界への道を準備」),
//!    sealed with a real wide time-lock to T([`ARRIVE_BELL`]) under the quicknet key, the canonical message of
//!    `fclient::experimental_expedition_message::prepare_depart` signed by the participant's TEST wallet alone.
//! 5. REAL, keeper A, nothing sent by the test: the origin's departure bell (the play duty's gather and resolve, handed
//!    the bell by the `expeditions` role), **ExpeditionSettleOrigin**, THE anchor of bell 21 from the REAL round
//!    T(21), the **ExpeditionReveal** opened from that public round, the destination's catch-up wide **Resolve**s,
//!    **ExpeditionGather**, the arrival's **Resolve**, **SettleMember**.
//! 6. The host STAYS on ring 129; keeper A's feed guard is still `legacy` (the expedition's records applied, P10) and
//!    it keeps folding and resolving afterwards; the verifier (with the pinned `.so` for VX) judges the WHOLE season.
//!
//! **Declared patches** (logged, and the verifier's `declared` list): P5's, the troops, and THE anchor and SeedCache of
//! every bell no shipped round covers in every region (as P8), except bell 21's anchor (keeper A's real PostAnchor),
//! whose seed is declared over it.
#![allow(clippy::too_many_arguments)]
use super::war::{drive, Beacon, ARRIVE_BELL, ARRIVE_ROUND, TROOPS};
use super::*;
use fclient::decode::{Holding, Province};
use fclient::experimental_expedition_message::{prepare_depart, Target, DEPART_HEAP_FRAME};
use fclient::original_expedition_depart_draft::Draft;
use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
use frontier_abi::world_index::arrival::{
    arrival_slot_address, clash_inputs_address, wide_arrival, WideArrival, WideClashInputsHdr,
};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::march::MarchState;
use frontier_abi::world_index::seal::WidePlain;
use frontier_abi::world_index::{ProvinceKey, TileAddress};
use keeper_core::expedition_steps as steps;

fn program_rows(r: &Run<'_>, since_slot: u64) -> Vec<Value> {
    let program = r.c.program;
    r.lock()
        .feed(0, 1_000_000, Some(&program))
        .into_iter()
        .filter(|l| l.slot > since_slot)
        .map(|l| {
            json!({"slot": l.slot, "tx": super::super::ix_name(&l.wire, &program), "ok": l.err.is_none(),
                   "err": l.err, "compute_units": l.units, "fee": l.fee,
                   "lamports_from_payer": l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b))})
        })
        .collect()
}

pub(super) async fn flow(
    r: &mut Run<'_>,
    (hp, hq, site, nation): (i32, i32, u8, u8),
    target: WideCoord,
    extra: Value,
) -> Value {
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let program = r.c.program;
    let genesis_ts = r.clock().3;
    let mut beacon = Beacon {
        regions: (0..r.season()[S::REGIONS]).collect(),
        staged: Default::default(),
        from_bell: 0,
    };
    let war =
        r.c.war
            .as_ref()
            .map(|w| (w.keeper_api, w.token.clone()))
            .expect("keeper A's API");

    // 1. the rim village
    let player = Keypair::new(); // TEST key
    let w = player.pubkey();
    r.lock().airdrop(&w, 5 * SOL).unwrap();
    let now = r.now();
    r.send(
        "Join",
        &[ix::join(&a, w, w, nation, &w, now + 30 * 86_400, None)],
        &[&player],
        "participant",
    );
    let me = ix::Player {
        actor: w,
        payer: w,
        wallet: w,
    };
    r.send(
        &format!("FileTicket(rim {hp}, {hq} site {site})"),
        &[ix::file_ticket(
            &a,
            &me,
            &[ix::Site {
                p: hp as i16,
                q: hq as i16,
                site,
            }],
        )],
        &[&player],
        "participant",
    );
    let holding = a.holding(hp, hq, site);
    drive(
        r,
        &mut beacon,
        2.0,
        300,
        "keeper A settles the rim ticket",
        |r| {
            r.lock()
                .account(&holding)
                .is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    let href = ix::HoldingRef {
        p: hp as i16,
        q: hq as i16,
        site,
    };
    let final_ts = le_i64(&r.data(&holding).unwrap(), H::FINAL_TS);
    let t = final_ts.max(r.now()) + 60;
    while r.now() < t {
        drive(
            r,
            &mut beacon,
            20.0,
            120,
            "the clock passes final_ts",
            |r| r.now() >= t,
        )
        .await;
    }
    r.lock().set_paused(true);
    r.send(
        "Harvest (the lazy flip to final)",
        &[fclient::ix::v2::harvest(&a, &me, href)],
        &[&player],
        "participant",
    );
    assert_eq!(r.data(&holding).unwrap()[H::STATE], H::STATE_FINAL, "final");
    // 2. declared troops
    let mut hd = r.lock().account(&holding).unwrap();
    let ro = H::reserve(0);
    hd.data[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
    r.patch(
        holding,
        hd,
        &format!("{TROOPS} Spearmen in the rim village's reserve"),
    );

    // the route into ring 129 over the program's own masks
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let h0 = Holding::decode(&r.data(&holding).unwrap()).unwrap();
    let host_id = fclient::addr::host_id(hp, hq, site, h0.gen, h0.host_seq).unwrap();
    let host = resolver
        .legacy_host_ref(host_id)
        .expect("the legacy host ref");
    let home_key = host.key();
    let dest = ProvinceKey::new(home_key.world(), target);
    let dest_key = adr(frontier_abi::world_index::land::province_address(
        &ctx, target,
    ));
    let lands = vec![
        steps::masks_of(home_key, &r.data(&a.province(hp, hq)).unwrap()),
        steps::masks_of(
            dest,
            &r.data(&dest_key)
                .expect("the ring-129 province keeper A opened"),
        ),
    ];
    let home_pv = Province::decode(&r.data(&a.province(hp, hq)).unwrap()).unwrap();
    let route = (0..61u8)
        .filter(|t| home_pv.passable_mask & (1u64 << t) != 0)
        .filter_map(|t| {
            let o = TileAddress::new(home_key, t).ok()?;
            steps::derive_route(o, dest, &lands).map(|rt| (t, rt))
        })
        .min_by_key(|(_, rt)| rt.dirs.len())
        .expect("a passable route from the home province into ring 129");
    let (start, route) = route;
    let upper = steps::travel_upper(&route.steps, &lands);
    let dest_region = WideProvince::read(&r.data(&dest_key).unwrap())
        .unwrap()
        .region;
    // the Depart bell: the latest whose earliest arrival (the slowest doctrine) is bell 21
    let depart_t = |b: u32| genesis_ts + 600 * b as i64 + 30;
    let depart_bell = (ARRIVE_BELL.saturating_sub(70)..=ARRIVE_BELL - 2)
        .rev()
        .find(|&b| {
            permutation_rules::frontier::travel::earliest_arrival_bell(
                genesis_ts,
                depart_t(b),
                upper,
            ) <= ARRIVE_BELL
        })
        .expect("a Depart bell for the arrival bell 21");
    assert!(
        r.bell() < depart_bell,
        "bell {} is past the Depart bell {depart_bell}",
        r.bell()
    );

    // 3. resident home, Muster onto the route's start tile
    drive(
        r,
        &mut beacon,
        10.0,
        600,
        "keeper A resolves the home province to the current bell",
        |r| {
            r.province_of(hp, hq)
                .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);
    let muster = r.send(
        &format!("Muster {TROOPS} onto tile {start}"),
        &[ix::muster(&a, &me, href, 0, TROOPS, start)],
        &[&player],
        "participant",
    );
    assert!(r.bell() < depart_bell, "mustered too late");
    drive(
        r,
        &mut beacon,
        40.0,
        1500,
        "five minutes before the Depart bell",
        |r| r.now() >= depart_t(depart_bell) - 330,
    )
    .await;
    drive(
        r,
        &mut beacon,
        2.0,
        900,
        "the Depart bell, the home resident",
        |r| {
            assert!(
                r.bell() <= depart_bell,
                "the Depart bell {depart_bell} passed before the home was resident"
            );
            r.now() >= depart_t(depart_bell)
                && r.province_of(hp, hq)
                    .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);

    // 4. ONE ExpeditionDepart, sealed to the real round T(21)
    let sd = r.season();
    let season = fclient::decode::Season::decode(&sd).unwrap();
    let clock = fclient::clock::SeasonClock::from_season(&season);
    assert_eq!(
        clock.tlock_round(ARRIVE_BELL),
        ARRIVE_ROUND,
        "T(21) is the real round"
    );
    let tip = fclient::fees::min_tip_lamports(
        season.min_reveal_priority_milli,
        season.reveal_cu_limit,
        season.reveal_loaded_limit,
    );
    let (path_len, path_bits) =
        permutation_rules::frontier::seal::encode_path(&route.dirs).unwrap();
    let plain = WidePlain {
        version: frontier_abi::world_index::seal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: ARRIVE_BELL,
        dest,
        dest_tile: route.dest_tile,
        stance: 0,
        retreat_bps: 0,
        path_len,
        path: path_bits,
        reserved: [0; frontier_abi::world_index::seal::WIDE_RESERVED_BYTES],
    };
    let qn = fclient::beacon::quicknet_info();
    let sealed =
        fclient::wide_seal::seal_wide(&plain, &host, ARRIVE_BELL, &qn.public_key, ARRIVE_ROUND)
            .unwrap();
    let draft = Draft::for_wallet(
        &ctx,
        host,
        home_key,
        w,
        w,
        0,
        ARRIVE_BELL,
        tip,
        sealed.commit,
        sealed.seal,
    )
    .expect("the canonical Depart draft");
    let since = r.lock().slot();
    let depart_row = {
        let mut c = r.lock();
        let (blockhash, last_valid) = c.latest_blockhash();
        let obs = BlockhashObservation {
            blockhash: blockhash.to_bytes(),
            context_slot: c.slot(),
            valid: true,
            block_height: last_valid.saturating_sub(100),
            last_valid_block_height: last_valid,
        };
        let prepared = prepare_depart(
            &draft,
            Target {
                program,
                season: a.season,
                program_version: frontier_stack::operator::PLAYABLE_VERSION,
            },
            obs,
            fclient::tx::TxBudget {
                cu_limit: 400_000,
                cu_price: 0,
                loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
                heap: Some(DEPART_HEAP_FRAME),
            },
            Limits {
                max_locks: 32,
                max_writes: 16,
                min_context_slot: 0,
                min_remaining_block_heights: 2,
            },
        )
        .expect("the canonical Depart message");
        let t = fclient::tx::sign(prepared.message().clone(), &[&player]).unwrap();
        let before = c.balance(&w);
        let sig = c.submit(&fclient::tx::wire(&t)).expect("submitted");
        c.produce_block();
        let l = c.transaction(&sig).cloned().expect("landed");
        assert_eq!(l.err, None, "the real ExpeditionDepart: {:?}", l.logs);
        json!({"tx": format!("ExpeditionDepart → ({}, {}) tile {}, arrival bell {ARRIVE_BELL}", target.p(), target.q(), route.dest_tile),
               "by": "participant", "ok": true, "compute_units": l.units, "fee": l.fee, "slot": l.slot,
               "lamports_from_payer": before.saturating_sub(c.balance(&w))})
    };
    r.rows.push(depart_row.clone());
    let external = steps::external_of(&a, &holding, 0);
    let transit = |r: &Run<'_>| {
        let read = |k: &Address| r.lock().account(k);
        steps::bridge_transit(&read, &a, &holding, 0)
            .ok()
            .flatten()
            .map(|x| x.1)
    };
    assert_eq!(transit(r).map(|t| t.state), Some(MarchState::Departed));
    let depart_wall = Instant::now();

    // 5. keeper A, nothing sent by the test
    drive(
        r,
        &mut beacon,
        6.0,
        1500,
        "keeper A resolves the origin bell and sends SettleOrigin",
        |r| transit(r).is_some_and(|t| t.state != MarchState::Departed),
    )
    .await;
    let anchor = adr(ctx.bell_anchor(ARRIVE_BELL, dest_region));
    drive(
        r,
        &mut beacon,
        10.0,
        1500,
        "keeper A posts THE anchor of bell 21 from the real round",
        |r| r.data(&anchor).is_some(),
    )
    .await;
    let ad = r.data(&anchor).unwrap();
    let anchor_round = u64::from_le_bytes(ad[BA::ROUND..BA::ROUND + 8].try_into().unwrap());
    assert_eq!(
        anchor_round, ARRIVE_ROUND,
        "the arrival bell is anchored on the real round"
    );
    let slots: Vec<Address> = (0..4u8)
        .map(|i| adr(arrival_slot_address(&ctx, dest, ARRIVE_BELL, nation, i)))
        .collect();
    drive(
        r,
        &mut beacon,
        3.0,
        1200,
        "keeper A reveals the expedition (a wide ArrivalSlot of bell 21)",
        |r| slots.iter().any(|s| r.data(s).is_some()),
    )
    .await;
    let rn_dest = |r: &Run<'_>| {
        let read = |k: &Address| r.lock().account(k);
        steps::resolved_next_at(&read, &a, &dest_key).unwrap_or(0)
    };
    drive(
        r,
        &mut beacon,
        6.0,
        1800,
        "keeper A catches the destination up and resolves the arrival bell",
        |r| rn_dest(r) > ARRIVE_BELL,
    )
    .await;
    let ci = adr(clash_inputs_address(&ctx, dest, ARRIVE_BELL));
    let position = {
        let i = slots.iter().position(|s| r.data(s).is_some()).unwrap() as u8;
        nation * 4 + i
    };
    let settled = |r: &Run<'_>| {
        r.data(&ci)
            .and_then(|d| WideClashInputsHdr::read(&d).ok())
            .is_some_and(|h| h.settled_mask & (1 << position) != 0)
    };
    drive(
        r,
        &mut beacon,
        6.0,
        1500,
        "keeper A sends SettleMember",
        settled,
    )
    .await;
    r.lock().set_paused(true);
    let inputs = r.data(&ci).unwrap();
    let row = WideArrival::read_at(&inputs, position as usize)
        .unwrap()
        .expect("the arrival's row");
    assert_eq!(row.host, host, "the row is the participant's host");
    assert_eq!(
        row.fate,
        wide_arrival::FATE_STAYS,
        "the host STAYS on ring 129 (fate {})",
        row.fate
    );
    let dest_bytes = r.data(&dest_key).unwrap();
    let host_bytes = host.to_bytes();
    let resident_at_dest = dest_bytes
        .windows(host_bytes.len())
        .any(|w| w == host_bytes);
    let expedition_wall = depart_wall.elapsed().as_secs_f64();
    let after_settle_slot = r.lock().slot();
    let keeper_steps = program_rows(r, since);

    // 6. keeper A keeps every duty afterwards: three more bells of folds / resolves, the guard not latched
    let bell_after = r.bell();
    drive(
        r,
        &mut beacon,
        10.0,
        900,
        "three more bells after the settlement",
        |r| r.bell() >= bell_after + 3,
    )
    .await;
    r.lock().set_paused(true);
    let after_rows = program_rows(r, after_settle_slot);
    let keeper_ok_after: Vec<&Value> = after_rows.iter().filter(|x| x["ok"] == true).collect();
    assert!(
        keeper_ok_after.iter().any(|x| x["tx"]
            .as_str()
            .is_some_and(|t| t.contains("Fold") || t.contains("Skip") || t.contains("Resolve"))),
        "keeper A folds / resolves after the expedition: {after_rows:#?}"
    );
    let status = super::keeper_status(war.0, &war.1).expect("keeper A's status");
    for idx in ["land", "play"] {
        let f = &status["discovery"][idx];
        assert_eq!(f["state"], "legacy", "{idx}: {f}");
        assert_eq!(f["blocker"], Value::Null, "{idx}: {f}");
        for k in [
            "EXPEDITION_DEPART",
            "EXPEDITION_SETTLE_ORIGIN",
            "EXPEDITION_REVEAL",
            "EXPEDITION_GATHER",
            "EXPEDITION_SETTLE_MEMBER",
        ] {
            assert!(
                f["wide_accounted"][k].as_u64().unwrap_or(0) >= 1,
                "{idx}: {k} applied: {f}"
            );
        }
    }

    // the verifier judges the whole season (the pinned .so given for VX's re-execution)
    let verdict = judge_season(r);

    let wanted = [
        "ExpeditionSettleOrigin",
        "ExpeditionReveal",
        "ExpeditionGather",
        "SettleMember",
    ];
    for k in wanted {
        assert!(
            keeper_steps
                .iter()
                .any(|x| x["ok"] == true && x["tx"].as_str().is_some_and(|t| t.contains(k))),
            "keeper A landed {k}: {keeper_steps:#?}"
        );
    }
    json!({"p10_expedition": "a test participant's rim → wide expedition on the devnet .so: ONE ExpeditionDepart; keeper A sends every later step",
        "plan": {"home": [hp, hq], "site": site, "nation": nation, "target": [target.p(), target.q()], "dest_region": dest_region,
                 "route": {"start_tile": start, "dirs": route.dirs, "dest_tile": route.dest_tile, "travel_upper_secs": upper},
                 "depart_bell": depart_bell, "arrive_bell": ARRIVE_BELL, "external": external.to_string()},
        "muster": muster, "depart": depart_row, "keeper_steps_after_depart": keeper_steps,
        "outcome": {"fate": row.fate, "stays": row.fate == wide_arrival::FATE_STAYS, "host_in_destination_province": resident_at_dest,
                    "destination_resolved_next": rn_dest(r), "wall_secs_depart_to_settle": expedition_wall},
        "after": {"bells": 3, "keeper_rows": after_rows.len(), "keeper_ok": keeper_ok_after.len(),
                  "feed": {"land": status["discovery"]["land"], "play": status["discovery"]["play"]},
                  "expeditions_role": status["expeditions"]},
        "verifier": verdict, "rows": r.rows.clone(), "declared_patches": r.patches.clone(), "setup": extra})
}

/// The verifier over the whole season (every program transaction from AnnounceSeason on, the UNFILTERED feed with
/// post-states, every declared patch), VX given the pinned `.so`: no FAIL; what is UNVERIFIABLE is listed.
fn judge_season(r: &Run<'_>) -> Value {
    let program = r.c.program;
    let (txs, mut finals) = {
        let c = r.lock();
        let txs: Vec<fclient::ports::TxRecord> = c
            .feed(0, usize::MAX, Some(&program))
            .into_iter()
            .map(|l| l.record())
            .collect();
        let finals: std::collections::BTreeMap<[u8; 32], Option<Account>> =
            verify_core::input::written_keys(&txs)
                .into_iter()
                .map(|k| (k.to_bytes(), c.account(&k)))
                .collect();
        (txs, finals)
    };
    for d in &r.declared {
        finals
            .entry(d.key)
            .or_insert_with(|| r.lock().account(&adr(d.key)).filter(|a| a.lamports > 0));
    }
    let so = super::super::devnet_so();
    let sha: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(&so).into();
    let sd = r.season();
    let ruleset: [u8; 32] = fclient::decode::Season::decode(&sd).unwrap().ruleset_hash;
    let inp = verify_core::input::Input {
        cfg: verify_core::input::Config {
            program,
            season_id: SEASON_ID,
            quicknet_pk: fclient::beacon::quicknet_info().public_key,
            ruleset_hash: ruleset,
            program_hash: Some(sha),
        },
        final_slot: r.lock().slot(),
        txs,
        finals,
        program_hashes: vec![(0, sha)],
        provenance: "stack operator_playable P10 (devnet-expedition-keeper)".into(),
        scenarios: vec!["p10-expedition".into()],
        history: Default::default(),
        resident_feed: None,
        program_so: Some(std::sync::Arc::new(so)),
        declared: r.declared.clone(),
        chain: Default::default(),
    };
    let rep = verify_core::verify(&inp);
    let findings: Vec<Value> = rep
        .findings
        .iter()
        .map(|f| json!({"severity": format!("{:?}", f.severity), "check": f.check, "code": f.code, "entity": f.entity,
                         "detail": f.detail.chars().take(300).collect::<String>()}))
        .collect();
    let fails: Vec<&Value> = findings
        .iter()
        .filter(|f| f["severity"] == "Fail")
        .collect();
    if let Ok(d) = std::env::var("OPERATOR_EVIDENCE_DIR") {
        let _ = std::fs::write(
            std::path::Path::new(&d).join("p10-verifier-findings.json"),
            serde_json::to_string_pretty(&findings).unwrap(),
        );
    }
    assert!(
        fails.is_empty(),
        "the verifier FAILs the season: {fails:#?}"
    );
    json!({"verdict": format!("{:?}", rep.verdict), "checks_run": rep.checks_run, "findings": findings.len(),
           "fail": fails.len(), "transactions": inp.txs.len()})
}
