//! P14 (devnet-guard-conquest; devnet gap P14, option (a): the program and the `.so` unchanged): a THIRD PARTY's wide
//! Free City conquest on a devnet wide season, offline, on the exact devnet `.so`, while keeper A runs every role.
//!
//! The devnet `.so` keeps the Free City conquest kinds 12–18 of the version-2 wrapper open (runbook P14; only the raw
//! commands are closed by `CONQUEST_LIFECYCLE_ENABLED = false`). After P10's expedition, routed onto the Free City's
//! tile of its ring-129 destination (the host STAYS there, keeper A having sent every step after the Depart), nobody
//! but the test sends a conquest step; keeper A is never asked to:
//!
//! 1. the destination caught up to one bell behind the clock by plain wide Resolves (a third party's; a bell resolves
//!    only after its reveal window closes, in the bell after next, so the cursor always lags by one);
//! 2. **DeclareSiege** (kind 12; the host's own wallet) of the Free City site: with the cursor one bell behind it is a
//!    RESERVATION (receipt action RESERVE, as in every recording of the pinned `.so`), applied at its bell;
//! 3. **ResolveWithConquest** (13) every bell by a STRANGER key (permissionless); once the siege has progress, the
//!    host leaves (**Dissolve**, kind 4, the host's wallet) so the siege FAILS;
//! 4. **SettleSiege** (15, the stranger);
//! 5. a second **DeclareSiege** while the province's cursor lags: a RESERVATION (receipt action RESERVE), NOT_APPLIED
//!    at its bell (the host left), and **SettleReservation** (18, the stranger); the host's **Return** (5);
//! 6. the Season's end (EndSeason by the stranger; the chain clock moved, keeper A running), the 72 h grace, then
//!    **CloseCaptureEscrow** (17) and **CloseConquest** (16) (the stranger).
//!
//! After every step keeper A's feed guard must still be `legacy` with no blocker and count the conquest records it read
//! (`feedguard.rs` P14). Not exercised here: **SettleCapture** (14), the other end of the same siege (the host stays and
//! the siege captures); the real recordings of the pinned `.so` carry it (`keeper/tests/expedition_feed_guard.rs`).
//! Declared patches: P10's (the troops, the beacon's anchors and seeds of the bells no shipped round covers).
#![allow(clippy::too_many_arguments)]
use super::war::{drive, Beacon};
use super::*;
use frontier_abi::world_index::arrival as wa;
use frontier_abi::world_index::conquest::{
    capture_escrow_address, conquest_address, WideCaptureEscrow, WideConquest, RES_NOT_APPLIED,
};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_dispatch_ix as dx;
use frontier_abi::world_index::roster as wro;
use frontier_abi::world_index::{ProvinceKey, WideHostRef};

/// What the conquest acts on: P10's participant, its rim holding and host, the destination and its Free City.
pub(super) struct Siege<'k> {
    pub player: &'k Keypair,
    pub holding: Address,
    pub host: WideHostRef,
    pub dest: ProvinceKey,
    pub dest_key: Address,
    pub region: u8,
    pub site: u8,
    pub tile: u8,
    /// Keeper A's API port and token.
    pub war: (u16, String),
}

fn heap_budget() -> tx::TxBudget {
    tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        // (the wrapper's DeclareSiege does not complete in the default 32 KiB heap; as the recorder)
        heap: Some(256 * 1024),
    }
}

fn meta(k: Address, signer: bool, writable: bool) -> AccountMeta {
    if writable {
        AccountMeta::new(k, signer)
    } else {
        AccountMeta::new_readonly(k, signer)
    }
}

/// A wide Resolve (`conquest` false) or ResolveWithConquest (kind 13) of `bell` (as the recorder's).
fn resolve_ix(
    a: &Addresses,
    payer: &Address,
    s: &Siege<'_>,
    bell: u32,
    conquest: bool,
) -> Instruction {
    let ctx = rim_ctx(a);
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(s.dest_key, false),
        AccountMeta::new(adr(wro::roster_address(&ctx, s.dest)), false),
        AccountMeta::new_readonly(a.seed_cache(bell, s.region, 0), false),
        AccountMeta::new_readonly(a.anchor(bell, s.region), false),
        AccountMeta::new(adr(wa::clash_inputs_address(&ctx, s.dest, bell)), false),
        AccountMeta::new_readonly(
            adr(wa::arrival_day_address(&ctx, s.dest, wa::day_of(bell))),
            false,
        ),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ];
    let data = if conquest {
        accounts.push(AccountMeta::new(adr(conquest_address(&ctx, s.dest)), false));
        dx::encode(
            dx::Kind::ResolveWithConquest,
            &wix::ResolveWithConquest {
                bell,
                beneficiary: payer.to_bytes(),
            }
            .to_bytes(),
        )
        .unwrap()
    } else {
        wix::Resolve {
            bell,
            beneficiary: payer.to_bytes(),
        }
        .to_bytes()
        .to_vec()
    };
    Instruction {
        program_id: a.program,
        accounts,
        data,
    }
}

fn rim_ctx(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

fn resolved_next(r: &Run<'_>, s: &Siege<'_>) -> u32 {
    le_u32(&r.data(&s.dest_key).unwrap(), PV::RESOLVED_NEXT)
}

/// The close of THE anchor's reveal window of `bell` in the destination's region, once the anchor exists.
fn window_close(r: &Run<'_>, s: &Siege<'_>, bell: u32) -> Option<i64> {
    let (_, sched, _, _) = r.clock();
    let ad = r.data(&r.c.a.anchor(bell, s.region))?;
    Some(kb::reveal_close(
        le_i64(&ad, BA::A),
        kb::window(&sched, bell),
    ))
}

/// Keeper A's feed guard after a step: never latched, both indexes `legacy`. → the `play` index's counters.
fn guard_ok(r: &mut Run<'_>, s: &Siege<'_>, after: &str) -> Value {
    let st = super::keeper_status(s.war.0, &s.war.1).expect("keeper A's status");
    for idx in ["land", "play"] {
        let f = &st["discovery"][idx];
        assert_eq!(
            f["blocker"],
            Value::Null,
            "after {after}: {idx} latched: {f}"
        );
        assert_ne!(f["state"], "blocked", "after {after}: {idx}: {f}");
    }
    assert!(
        r.c.keeper.try_wait().ok().flatten().is_none(),
        "keeper A exited after {after}"
    );
    st["discovery"]["play"]["wide_accounted"].clone()
}

/// Keeper A has read the feed up to the latest program transaction and counts `k` at least `n` times (both indexes).
async fn keeper_reads(
    r: &mut Run<'_>,
    beacon: &mut Beacon,
    s: &Siege<'_>,
    k: &str,
    n: u64,
    with_beacon: bool,
) -> Value {
    let t0 = Instant::now();
    loop {
        let st = super::keeper_status(s.war.0, &s.war.1);
        if let Some(st) = &st {
            // (`k` may name alternatives, `A|B`: their counts are summed)
            let ok = ["land", "play"].iter().all(|i| {
                k.split('|')
                    .map(|x| {
                        st["discovery"][i]["wide_accounted"][x]
                            .as_u64()
                            .unwrap_or(0)
                    })
                    .sum::<u64>()
                    >= n
            });
            if ok {
                return guard_ok(r, s, k);
            }
            for idx in ["land", "play"] {
                assert_eq!(
                    st["discovery"][idx]["blocker"],
                    Value::Null,
                    "keeper A latched while reading {k}: {st}"
                );
            }
        }
        assert!(
            t0.elapsed() < Duration::from_secs(600),
            "keeper A does not count {k} ≥ {n}: {st:?}"
        );
        {
            let mut c = r.lock();
            c.set_scale(1.0);
            c.set_paused(false);
        }
        if with_beacon {
            beacon.tick(r);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        r.lock().set_paused(true);
    }
}

/// One conquest-or-plain Resolve of the destination's next bell by `who`, once its anchor and seed exist and its
/// window closed (the chain run with keeper A until then). `None` when the next bell has not ended yet.
async fn resolve_next(
    r: &mut Run<'_>,
    beacon: &mut Beacon,
    s: &Siege<'_>,
    who: &Keypair,
    conquest: bool,
) -> Option<Value> {
    let b = resolved_next(r, s);
    if b >= r.bell() {
        return None;
    }
    let seed = r.c.a.seed_cache(b, s.region, 0);
    drive(
        r,
        beacon,
        6.0,
        900,
        &format!("bell {b}'s anchor, seed and window close"),
        |r| r.data(&seed).is_some() && window_close(r, s, b).is_some_and(|c| r.now() > c + 1),
    )
    .await;
    r.lock().set_paused(true);
    let a = r.c.a.clone();
    let ix = resolve_ix(&a, &who.pubkey(), s, b, conquest);
    let name = if conquest {
        format!("ResolveWithConquest bell {b}")
    } else {
        format!("WideResolve bell {b} (catch-up)")
    };
    let v = r.try_send_budget(
        &name,
        &[ix],
        &[who],
        "third party (stranger)",
        heap_budget(),
    );
    // (someone else resolved the bell first: no error of ours)
    assert!(v["ok"] == true || resolved_next(r, s) > b, "{name}: {v:#}");
    Some(v)
}

pub(super) async fn flow(r: &mut Run<'_>, beacon: &mut Beacon, s: Siege<'_>) -> Value {
    let a = r.c.a.clone();
    let ctx = r.ctx();
    let program = r.c.program;
    let world = s.dest.world();
    let stranger = Keypair::new(); // TEST key: the third party
    r.lock().airdrop(&stranger.pubkey(), 20 * SOL).unwrap();
    let w = s.player.pubkey();
    let citizen = a.citizen(&w);
    let conquest_k = adr(conquest_address(&ctx, s.dest));
    let escrow_k = adr(capture_escrow_address(&ctx, &citizen.to_bytes()));
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let mut steps: Vec<Value> = vec![];
    let mut guard: Vec<Value> = vec![];
    let row_of = |v: &Value, kind: &str| json!({"kind": kind, "row": v});

    // 0. DECLARED PATCH: the rim village's stores hold two declarations' cost (the gold stake and the siege arms;
    //    natural production would take days of chain time — as the recorder's patch 3 and P10's troops)
    {
        use frontier_abi::layout::player::accrual as AC;
        use permutation_rules::frontier::{arms, holding::Resource};
        let mut hd = r.lock().account(&s.holding).expect("the rim village");
        for (res, need) in [
            (Resource::Gold as usize, 2_000_000i64),
            (arms::ARMS as usize, 200_000i64),
        ] {
            let o = H::store(res);
            for f in [AC::VALUE, AC::CAP] {
                let v = i64::from_le_bytes(hd.data[o + f..o + f + 8].try_into().unwrap()).max(need);
                hd.data[o + f..o + f + 8].copy_from_slice(&v.to_le_bytes());
            }
        }
        r.patch(
            s.holding,
            hd,
            "the rim village's gold and arms stores: two DeclareSieges' cost (2,000 gold, 200 arms)",
        );
    }

    // 1. the destination resolved to one bell behind the clock (plain wide Resolves), then the DeclareSiege
    let declared = {
        // (a bell resolves only after THE anchor's reveal window closes, which is in the bell after next: the cursor
        //  always lags the clock by one bell, so the declaration is a RESERVATION — as in every recording of the
        //  pinned `.so` — applied when ResolveWithConquest reaches its bell)
        while resolved_next(r, &s) + 1 < r.bell() {
            match resolve_next(r, beacon, &s, &stranger, false).await {
                Some(v) => steps.push(row_of(&v, "WideResolve (catch-up)")),
                None => break,
            }
        }
        r.lock().set_paused(true);
        let pd = r.data(&s.dest_key).unwrap();
        // (the host's entry: on the Free City's tile, on the roster; nobody else stands there)
        let entry = (0..pd[PV::N_ENTRIES] as usize)
            .find(|&i| {
                frontier_abi::entry::read_entry(&pd, i)
                    .is_ok_and(|e| e.tile == s.tile && e.state == 1)
            })
            .map(|i| i as u8)
            .expect("the host's entry on the Free City's tile");
        let d = fclient::wide_conquest_draft::Draft::declare_siege(
            &ctx, s.host, s.dest, s.site, entry, w,
        )
        .expect("a DeclareSiege draft");
        let ix = Instruction {
            program_id: program,
            accounts: d
                .roles()
                .iter()
                .map(|ro| meta(ro.address, ro.signer, ro.writable))
                .collect(),
            data: dx::encode(dx::Kind::DeclareSiege, &d.inner_bytes()).unwrap(),
        };
        let v = r.try_send_budget(
            &format!(
                "DeclareSiege of the Free City (site {}, tile {}) from entry {entry}",
                s.site, s.tile
            ),
            &[ix],
            &[s.player],
            "the host's own wallet (third party to keeper A)",
            heap_budget(),
        );
        // (fail fast: a refusal is a program answer, never retried in a loop)
        assert_eq!(v["ok"], true, "DeclareSiege refused: {v:#}");
        (entry, v)
    };
    let (entry, v) = declared;
    steps.push(row_of(&v, "DeclareSiege (12)"));
    let table = |r: &Run<'_>| WideConquest::read(&r.data(&conquest_k)?, a.season_id, s.dest).ok();
    assert!(table(r).is_some(), "the conquest table exists");
    let acc = keeper_reads(
        r,
        beacon,
        &s,
        "CONQUEST_DECLARED|CONQUEST_RESERVED",
        1,
        true,
    )
    .await;
    guard.push(json!({"after": "DeclareSiege", "wide_accounted": acc}));

    // 2. ResolveWithConquest every bell; the host leaves once the siege has progress; the siege fails
    use frontier_abi::v2::layout::province::conquest as CR;
    let mut left: Option<u32> = None;
    let mut rwc = 0u64;
    let mut ended = None;
    let mut started = false;
    for _ in 0..80 {
        let Some(v) = resolve_next(r, beacon, &s, &stranger, true).await else {
            drive(r, beacon, 20.0, 900, "the next bell", |r| {
                resolved_next(r, &s) < r.bell()
            })
            .await;
            continue;
        };
        rwc += 1;
        steps.push(row_of(&v, "ResolveWithConquest (13)"));
        let e = table(r)
            .and_then(|t| t.entry(s.site).ok().flatten())
            .map(|e| {
                (
                    e.rules.kind,
                    e.rules.progress,
                    e.rules.required,
                    e.source.is_some(),
                )
            });
        steps.push(json!({"kind": "site record", "after_bell": resolved_next(r, &s) - 1, "record": format!("{e:?}")}));
        if e.is_some_and(|(k, ..)| k != CR::KIND_NONE) {
            started = true;
        }
        match e {
            // (a reservation not applied yet: no site entry, or none running)
            None => {}
            Some((k, ..)) if !started && k == CR::KIND_NONE => {}
            Some((k, _, _, src)) if k == CR::KIND_NONE || k == CR::KIND_CAPTURE_DUE => {
                ended = Some((k, src));
                break;
            }
            Some((_, progress, _, _)) if progress >= 1 && left.is_none() => {
                let d = fclient::wide_resident_draft::Draft::for_wallet(&ctx, s.host, s.dest, w, w)
                    .expect("a Dissolve draft");
                let ix = Instruction {
                    program_id: program,
                    accounts: d
                        .roles()
                        .iter()
                        .map(|ro| meta(ro.address, ro.signer, ro.writable))
                        .collect(),
                    data: dx::encode(dx::Kind::Dissolve, &d.proposed_bytes()).unwrap(),
                };
                let v = send_heap(
                    r,
                    "Dissolve while the siege runs (the host leaves)",
                    &[ix],
                    &[s.player],
                    "the host's own wallet",
                );
                steps.push(row_of(&v, "Dissolve (4)"));
                left = Some(r.bell());
            }
            _ => {}
        }
    }
    let (kind, has_source) = ended.expect("the siege ended (FAILED or capture due)");
    let acc = keeper_reads(r, beacon, &s, "CONQUEST_RESOLVED", rwc, true).await;
    guard.push(json!({"after": format!("{rwc} ResolveWithConquest"), "wide_accounted": acc}));

    // 3. SettleSiege (the stranger) of the failed siege (or SettleCapture if it captured after all)
    let escrow = r
        .data(&escrow_k)
        .and_then(|d| WideCaptureEscrow::read(&d, a.season_id, world, citizen.to_bytes()).ok())
        .expect("the capture escrow");
    let src = s.holding;
    let settle_kind = if kind == CR::KIND_CAPTURE_DUE {
        let ix = Instruction {
            program_id: program,
            data: dx::encode(
                dx::Kind::SettleCapture,
                &wix::SettleCapture { site: s.site }.to_bytes(),
            )
            .unwrap(),
            accounts: vec![
                AccountMeta::new(stranger.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(s.dest_key, false),
                AccountMeta::new(conquest_k, false),
                AccountMeta::new(citizen, false),
                AccountMeta::new(
                    a.join_shard(nation_of(r, &citizen), shard_of(r, &citizen)),
                    false,
                ),
                AccountMeta::new(escrow_k, false),
                AccountMeta::new(
                    adr(frontier_abi::world_index::holding::holding_address(
                        &ctx,
                        s.dest.coord(),
                        s.site,
                    )),
                    false,
                ),
                AccountMeta::new(src, false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
        };
        let v = send_heap(
            r,
            "SettleCapture",
            &[ix],
            &[&stranger],
            "third party (stranger)",
        );
        steps.push(row_of(&v, "SettleCapture (14)"));
        "CONQUEST_CAPTURED"
    } else {
        let mut m = vec![
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(s.dest_key, false),
            AccountMeta::new(conquest_k, false),
            AccountMeta::new(citizen, false),
            AccountMeta::new(escrow_k, false),
            AccountMeta::new(adr(escrow.funder()), false),
        ];
        if has_source {
            m.push(AccountMeta::new(src, false));
        }
        let ix = Instruction {
            program_id: program,
            data: dx::encode(
                dx::Kind::SettleSiege,
                &wix::SettleSiege { site: s.site }.to_bytes(),
            )
            .unwrap(),
            accounts: m,
        };
        let v = send_heap(
            r,
            "SettleSiege",
            &[ix],
            &[&stranger],
            "third party (stranger)",
        );
        steps.push(row_of(&v, "SettleSiege (15)"));
        "CONQUEST_SETTLED"
    };
    let acc = keeper_reads(r, beacon, &s, settle_kind, 1, true).await;
    guard.push(json!({"after": settle_kind, "wide_accounted": acc}));

    // 4. (the siege failed, the host left) a second DeclareSiege while the cursor lags: a RESERVATION; NOT_APPLIED at
    //    its bell; SettleReservation; the host's Return
    let mut reservation = Value::Null;
    if kind == CR::KIND_NONE {
        // the cursor lags: the current bell has begun and is not resolved
        drive(
            r,
            beacon,
            20.0,
            900,
            "a bell the destination has not resolved",
            |r| resolved_next(r, &s) < r.bell(),
        )
        .await;
        r.lock().set_paused(true);
        let d = fclient::wide_conquest_draft::Draft::declare_siege(
            &ctx, s.host, s.dest, s.site, entry, w,
        )
        .expect("a DeclareSiege draft");
        let ix = Instruction {
            program_id: program,
            accounts: d
                .roles()
                .iter()
                .map(|ro| meta(ro.address, ro.signer, ro.writable))
                .collect(),
            data: dx::encode(dx::Kind::DeclareSiege, &d.inner_bytes()).unwrap(),
        };
        let v = r.try_send_budget(
            "DeclareSiege while the cursor lags (a reservation)",
            &[ix],
            &[s.player],
            "the host's own wallet",
            heap_budget(),
        );
        steps.push(row_of(&v, "DeclareSiege (12, RESERVE)"));
        if v["ok"] == true {
            let acc = keeper_reads(
                r,
                beacon,
                &s,
                "CONQUEST_DECLARED|CONQUEST_RESERVED",
                2,
                true,
            )
            .await;
            guard.push(json!({"after": "DeclareSiege (reservation)", "wide_accounted": acc}));
            let not_applied = |r: &Run<'_>| {
                table(r)?
                    .reservations()
                    .iter()
                    .flatten()
                    .find(|x| x.status == RES_NOT_APPLIED)
                    .copied()
            };
            for _ in 0..12 {
                if not_applied(r).is_some() {
                    break;
                }
                match resolve_next(r, beacon, &s, &stranger, true).await {
                    Some(v) => steps.push(row_of(&v, "ResolveWithConquest (13)")),
                    None => {
                        drive(r, beacon, 20.0, 900, "the next bell", |r| {
                            resolved_next(r, &s) < r.bell()
                        })
                        .await
                    }
                }
            }
            let res = not_applied(r).expect("the reservation is NOT_APPLIED (the host left)");
            let res_escrow_k = adr(capture_escrow_address(&ctx, &res.citizen));
            let funder = r
                .data(&res_escrow_k)
                .and_then(|d| WideCaptureEscrow::read(&d, a.season_id, world, res.citizen).ok())
                .map(|e| adr(e.funder()))
                .unwrap_or(stranger.pubkey());
            let source = adr(resolver.holding_address(&res.source()).unwrap());
            let ix = Instruction {
                program_id: program,
                data: dx::encode(
                    dx::Kind::SettleReservation,
                    &wix::SettleReservation { seq: res.seq }.to_bytes(),
                )
                .unwrap(),
                accounts: vec![
                    AccountMeta::new_readonly(stranger.pubkey(), true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new(s.dest_key, false),
                    AccountMeta::new(conquest_k, false),
                    AccountMeta::new(adr(res.citizen), false),
                    AccountMeta::new(res_escrow_k, false),
                    AccountMeta::new(funder, false),
                    AccountMeta::new(source, false),
                ],
            };
            let v = send_heap(
                r,
                &format!("SettleReservation seq {}", res.seq),
                &[ix],
                &[&stranger],
                "third party (stranger)",
            );
            steps.push(row_of(&v, "SettleReservation (18)"));
            let acc = keeper_reads(r, beacon, &s, "CONQUEST_SETTLED", 2, true).await;
            guard.push(json!({"after": "SettleReservation", "wide_accounted": acc}));
            reservation = json!({"seq": res.seq, "status": "NOT_APPLIED", "settled": true});
        }
        // the host's Return home once the destination resolved past its leave bell (permissionless)
        if let Some(pend) = left {
            for _ in 0..12 {
                if resolved_next(r, &s) > pend {
                    break;
                }
                match resolve_next(r, beacon, &s, &stranger, true).await {
                    Some(v) => steps.push(row_of(&v, "ResolveWithConquest (13)")),
                    None => {
                        drive(r, beacon, 20.0, 900, "the next bell", |r| {
                            resolved_next(r, &s) < r.bell()
                        })
                        .await
                    }
                }
            }
            let rt = fclient::wide_resident_draft::Draft::return_home(
                &ctx,
                s.host,
                s.dest,
                stranger.pubkey(),
            )
            .expect("a Return draft");
            let ix = Instruction {
                program_id: program,
                accounts: rt
                    .roles()
                    .iter()
                    .map(|ro| meta(ro.address, ro.signer, ro.writable))
                    .collect(),
                data: dx::encode(dx::Kind::Return, &rt.proposed_bytes()).unwrap(),
            };
            let v = try_send_heap(
                r,
                "Return (the host home)",
                &[ix],
                &[&stranger],
                "third party (stranger)",
            );
            steps.push(row_of(&v, "Return (5)"));
        }
    }
    let before_end = guard_ok(r, &s, "the siege");

    // 5. the Season's end and its grace (the chain clock moved; keeper A keeps running), then the closes
    let sd = r.season();
    let genesis_ts = r.clock().3;
    let end_bell = le_u32(&sd, S::END_BELL);
    let end = genesis_ts + 600 * end_bell as i64;
    let jump_wall = Instant::now();
    r.advance_exact(end + 1);
    let v = send_heap(
        r,
        "EndSeason",
        &[ix::end_season(&a, stranger.pubkey())],
        &[&stranger],
        "third party (stranger)",
    );
    steps.push(row_of(&v, "EndSeason"));
    r.advance_exact(end + frontier_abi::presets::END_GRACE_SECS + 1);
    let mut closes = vec![];
    if let Some(e) = r
        .data(&escrow_k)
        .and_then(|d| WideCaptureEscrow::read(&d, a.season_id, world, citizen.to_bytes()).ok())
    {
        let mut acc = vec![
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(citizen, false),
            AccountMeta::new(escrow_k, false),
            AccountMeta::new(adr(e.rent_payer()), false),
        ];
        if e.escrow() != 0 {
            acc.push(AccountMeta::new(adr(e.funder()), false));
        }
        let ix = Instruction {
            program_id: program,
            accounts: acc,
            data: dx::encode(
                dx::Kind::CloseCaptureEscrow,
                &wix::CloseCaptureEscrow.to_bytes(),
            )
            .unwrap(),
        };
        let v = send_heap(
            r,
            "CloseCaptureEscrow",
            &[ix],
            &[&stranger],
            "third party (stranger)",
        );
        steps.push(row_of(&v, "CloseCaptureEscrow (17)"));
        closes.push("CONQUEST_ESCROW_CLOSED");
    }
    if let Some(t) = table(r) {
        let ix = Instruction {
            program_id: program,
            data: dx::encode(
                dx::Kind::CloseConquest,
                &wix::CloseConquest {
                    p: s.dest.coord().p(),
                    q: s.dest.coord().q(),
                }
                .to_bytes(),
            )
            .unwrap(),
            accounts: vec![
                AccountMeta::new_readonly(stranger.pubkey(), true),
                AccountMeta::new_readonly(a.season, false),
                AccountMeta::new(conquest_k, false),
                AccountMeta::new(adr(t.rent_payer()), false),
            ],
        };
        let v = send_heap(
            r,
            "CloseConquest",
            &[ix],
            &[&stranger],
            "third party (stranger)",
        );
        steps.push(row_of(&v, "CloseConquest (16)"));
        closes.push("CONQUEST_TABLE_CLOSED");
    }
    // keeper A reads the closes (no beacon staging past the season: the anchors of 1,400 bells are not declared)
    for k in &closes {
        let acc = keeper_reads(r, beacon, &s, k, 1, false).await;
        guard.push(json!({"after": k, "wide_accounted": acc}));
    }
    let end_wall = jump_wall.elapsed().as_secs_f64();
    let _ = (&before_end, &resolver);
    json!({
        "free_city": {"site": s.site, "tile": s.tile, "province": [s.dest.coord().p(), s.dest.coord().q()]},
        "third_party": stranger.pubkey().to_string(), "host_wallet": w.to_string(),
        "siege_end": {"site_record_kind": kind, "capture_due": kind == CR::KIND_CAPTURE_DUE, "host_left_bell": left},
        "reservation": reservation, "closes": closes, "season_end_wall_secs": end_wall,
        "steps": steps, "keeper_a_guard_after_each": guard,
    })
}

fn nation_of(r: &Run<'_>, citizen: &Address) -> u8 {
    r.data(citizen).map(|d| d[C::FACTION]).unwrap_or(0)
}
fn shard_of(r: &Run<'_>, citizen: &Address) -> u8 {
    let d = r.data(citizen).unwrap_or_default();
    fclient::decode::Citizen::decode(&d)
        .map(|c| c.join_shard)
        .unwrap_or(0)
}

/// [`Run::send`] with the 256 KiB heap frame (the conquest bodies — ResolveWithConquest's included — and the
/// wrapper's resident steps fault in the default 32 KiB heap on the pinned `.so`).
fn send_heap(
    r: &mut Run<'_>,
    what: &str,
    ixs: &[Instruction],
    signers: &[&Keypair],
    who: &str,
) -> Value {
    let v = try_send_heap(r, what, ixs, signers, who);
    assert_eq!(v["ok"], true, "{what}: {v:#}");
    v
}
fn try_send_heap(
    r: &mut Run<'_>,
    what: &str,
    ixs: &[Instruction],
    signers: &[&Keypair],
    who: &str,
) -> Value {
    r.try_send_budget(what, ixs, signers, who, heap_budget())
}
