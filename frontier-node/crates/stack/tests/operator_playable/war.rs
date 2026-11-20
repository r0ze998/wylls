//! P8 / P9 (devnet-page-war): a LEGACY WAR on a devnet wide season, offline, on the exact devnet `.so`.
//!
//! After P4's rim world (the operator's setup, keeper A seeding the season and opening the rim's provinces), with
//! keeper A configured as the devnet profile now says — its play roles `reveal`, `settle-departure`, `gather`,
//! `resolve`, `skip`, `settle`, `close`, `claims` beside `beacon`, `rings`, `fold`, `tickets`, `wide-tickets`:
//!
//! 1. REAL, the participant (P8: a test key; P9: the web page with its wallet): Join and a one-site rim FileTicket;
//!    keeper A's `tickets` role settles it (the ticket bell's anchor and seed declared, as P4).
//! 2. REAL: the clock past the village's `final_ts`; Harvest flips it final.
//! 3. **Declared patch**: 400 Spearmen in the village's reserve (natural production would take days of chain time;
//!    as P6). (Train is the same command P1 ships; its cost is not the point here.)
//! 4. REAL, keeper A's `skip` role: the home province resolved bell by bell (SkipQuiet) so that Muster is resident;
//!    REAL, the participant: **Muster** 400 onto a tile of its province.
//! 5. REAL, the participant: ONE sealed **Depart** onto the **keep** of a neighbouring rim province (a contestable keep
//!    held by another nation), sealed to T([`ARRIVE_BELL`]) under the real quicknet key, at bell 19.
//! 6. REAL, keeper A, nothing sent by the test: SettleDeparture; at the arrival bell PostAnchor with the REAL round
//!    T(21) (drand-replay serves it: the shipped rounds plus that one); the seal opened off chain from the public
//!    round and **Reveal**; GatherClash; ResolveFromInputs (the clash with the keep's garrison); **SettleTransit**;
//!    every later bell of the contested keep; the capture; the donor's **return** settle.
//!
//! **Declared patches** (logged): THE anchor and the SeedCache of every bell no shipped round covers (every bell but
//! the arrival bell's anchor, which is keeper A's real PostAnchor), in the regions of the two provinces; the arrival
//! bell's SeedCache over keeper A's real anchor (its seed round S(21) is not shipped either). On devnet keeper A's
//! `beacon` role posts all of them from the live rounds.
#![allow(clippy::type_complexity, clippy::too_many_arguments)]
use super::*;
use fclient::decode::{Holding, Province};
use fclient::ix::v2 as ix2;
use permutation_rules::frontier::geometry::{locate, tile_offset};
use permutation_rules::hex::{Hex, DIRECTIONS};

/// The arrival bell: with the war genesis round 32 551 749, T(21) = 32 556 349 is a real quicknet round.
pub const ARRIVE_BELL: u32 = 21;
/// T(ARRIVE_BELL).
pub const ARRIVE_ROUND: u64 = 32_556_349;
/// The bell of the Depart (the program allows arrival bells `b + 2 ..= b + 72`).
pub const DEPART_BELL: u32 = ARRIVE_BELL - 2;
/// The host's troops (the declared reserve).
pub const TROOPS: u32 = 400;
/// The bells after the arrival the run waits for the capture and the return, at most.
pub const AFTER_BELLS: u32 = 48;

/// P10 (devnet-page-war-2): how the test stops and restarts keeper A (the same binary, config and journal) and
/// drand-replay (the full archive, or the one without T(21)), on the same ports.
#[derive(Clone)]
pub struct Outage {
    pub keeper_bin: std::path::PathBuf,
    pub keeper_config: std::path::PathBuf,
    pub drand_bin: std::path::PathBuf,
    pub drand_full: Vec<String>,
    pub drand_withheld: Vec<String>,
    pub drand_port: u16,
}

/// `(T(21), its real signature)`: the S-TLOCK q4 vector's previous round (as `verify/tests/playable_march.rs`).
pub fn arrive_round() -> (u64, [u8; 48]) {
    let p = fclient::seal::fixture_dir().join("q4-vector.json");
    let v: Value =
        serde_json::from_str(&std::fs::read_to_string(&p).expect("q4 vector")).expect("json");
    assert_eq!(v["round"].as_u64(), Some(ARRIVE_ROUND + 1));
    let sig = hex::decode(v["prev_round_sig"].as_str().expect("prev_round_sig")).expect("hex");
    (ARRIVE_ROUND, sig.try_into().expect("48 B"))
}

fn hex_of(p: i32, q: i32, t: u8) -> Option<Hex> {
    let c = ProvinceCoord::new(p, q).centre();
    let o = tile_offset(t)?;
    Some(Hex::new(c.q + o.q, c.r + o.r))
}

/// The shortest route over passable tiles of `home` and `target` only, from any passable tile of `home` to tile
/// `goal` of `target`: `(start_tile, dirs)` (as `itest::legacy_march`'s keep test).
pub fn route(
    home: (i32, i32),
    hp: u64,
    target: (i32, i32),
    tp: u64,
    goal: u8,
) -> Option<(u8, Vec<u8>)> {
    use std::collections::{HashMap, VecDeque};
    let ok = |pc: (i32, i32), t: u8| {
        t < 61 && ((pc == home && hp & (1u64 << t) != 0) || (pc == target && tp & (1u64 << t) != 0))
    };
    let mut prev: HashMap<(i32, i32), Option<((i32, i32), u8)>> = HashMap::new();
    let mut queue = VecDeque::new();
    for t in (0..61u8).filter(|t| hp & (1u64 << t) != 0) {
        let h = hex_of(home.0, home.1, t)?;
        prev.insert((h.q, h.r), None);
        queue.push_back(h);
    }
    while let Some(h) = queue.pop_front() {
        let (pc, t) = locate(h);
        if (pc.p, pc.q) == target && t == goal {
            let mut dirs = vec![];
            let mut cur = (h.q, h.r);
            while let Some(Some((from, d))) = prev.get(&cur) {
                dirs.push(*d);
                cur = *from;
            }
            dirs.reverse();
            let (_, st) = locate(Hex::new(cur.0, cur.1));
            return (dirs.len() <= permutation_rules::frontier::travel::MAX_PATH_STEPS)
                .then_some((st, dirs));
        }
        for d in 0..6u8 {
            let (dq, dr) = DIRECTIONS[d as usize];
            let n = Hex::new(h.q + dq, h.r + dr);
            let (npc, nt) = locate(n);
            if ok((npc.p, npc.q), nt) && !prev.contains_key(&(n.q, n.r)) {
                prev.insert((n.q, n.r), Some(((h.q, h.r), d)));
                queue.push_back(n);
            }
        }
    }
    None
}

impl Run<'_> {
    fn province_of(&self, p: i32, q: i32) -> Option<Province> {
        self.data(&self.c.a.province(p, q))
            .and_then(|d| Province::decode(&d).ok())
    }
    /// The SeedCache (nonce 0) of `(bell, region)` over THE anchor already on chain (keeper A's real one), with a
    /// literal seed: the seed round S(bell, A) is not a shipped round.
    fn stage_seed_over_anchor(&mut self, bell: u32, region: u8, seed: [u8; 32]) {
        let ctx = self.ctx();
        let (clock, sched, margin, _) = self.clock();
        let anchor_key = ctx.bell_anchor(bell, region);
        let ad = self.data(&adr(anchor_key)).expect("THE anchor");
        let a_ts = le_i64(&ad, BA::A);
        let round = kb::seed_round(
            &clock,
            kb::reveal_close(a_ts, kb::window(&sched, bell)),
            margin,
        );
        let mut cd = vec![0u8; K2::SeedCache.size()];
        assert!(frontier_abi::v2::layout::write_header(
            &mut cd,
            K2::SeedCache,
            SEASON_ID
        ));
        cd[SC::BELL..SC::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        cd[SC::REGION] = region;
        cd[SC::ROUND..SC::ROUND + 8].copy_from_slice(&round.to_le_bytes());
        cd[SC::SEED..SC::SEED + 32].copy_from_slice(&seed);
        cd[SC::ANCHOR_KEY..SC::ANCHOR_KEY + 32].copy_from_slice(&anchor_key);
        cd[SC::A..SC::A + 8].copy_from_slice(&a_ts.to_le_bytes());
        let program = self.c.program;
        self.patch(
            adr(ctx.seed_cache(bell, region, 0)),
            Account { lamports: SOL, data: cd, owner: program, executable: false },
            &format!("SeedCache(bell {bell}, region {region}, nonce 0) over keeper A's REAL anchor, literal seed"),
        );
    }
}

/// The declared beacon state of the run: every ended bell's anchor and seed in `regions` (except the arrival bell's
/// anchor, which keeper A posts from the real round; its seed is declared over it once it exists).
pub(super) struct Beacon {
    pub(super) regions: Vec<u8>,
    pub(super) staged: std::collections::BTreeSet<(u32, u8)>,
    pub(super) from_bell: u32,
}

impl Beacon {
    pub(super) fn tick(&mut self, r: &mut Run<'_>) {
        let now = r.now();
        let g = r.clock().3;
        let ctx = r.ctx();
        for b in self.from_bell..r.bell() {
            // (a bell's anchor exists from its end on; the arrival bell's waits for keeper A's real PostAnchor)
            let end = g + 600 * (b as i64 + 1);
            for &reg in &self.regions.clone() {
                if self.staged.contains(&(b, reg)) {
                    continue;
                }
                let seed = [(b as u8) ^ 0xA5 ^ reg; 32];
                if b == ARRIVE_BELL {
                    // (never declared: keeper A's beacon role anchors it from the real round; only its seed is declared)
                    if r.data(&adr(ctx.bell_anchor(b, reg))).is_some() {
                        r.stage_seed_over_anchor(b, reg, seed);
                        self.staged.insert((b, reg));
                    }
                    let _ = (now, end);
                    continue;
                }
                if r.data(&adr(ctx.bell_anchor(b, reg))).is_none() {
                    r.stage_seed(b, reg, seed);
                }
                self.staged.insert((b, reg));
            }
        }
    }
}

/// Lets the chain (and keeper A) run at `scale` with the declared beacon kept up, until `done` or `secs`.
pub(super) async fn drive(
    r: &mut Run<'_>,
    beacon: &mut Beacon,
    scale: f64,
    secs: u64,
    what: &str,
    mut done: impl FnMut(&Run<'_>) -> bool,
) {
    let t0 = Instant::now();
    loop {
        {
            let mut c = r.lock();
            c.set_scale(scale);
            c.set_paused(false);
        }
        beacon.tick(r);
        if done(r) {
            break;
        }
        assert!(
            r.c.keeper.try_wait().ok().flatten().is_none(),
            "{what}: keeper A exited"
        );
        if t0.elapsed() > Duration::from_secs(secs) {
            if let Ok(d) = std::env::var("OPERATOR_EVIDENCE_DIR") {
                for f in [
                    "keeper.log",
                    "drand-replay.log",
                    "herald.log",
                    "gateway.err.log",
                ] {
                    let _ = std::fs::copy(
                        r.c.dir.join(f),
                        std::path::Path::new(&d).join(format!("failed-{f}")),
                    );
                }
            }
            let log = std::fs::read_to_string(r.c.dir.join("keeper.log")).unwrap_or_default();
            let tail: Vec<_> = log.lines().rev().take(50).collect();
            let fails: Vec<String> = r
                .lock()
                .feed(0, 1_000_000, Some(&r.c.program))
                .into_iter()
                .filter(|l| l.err.is_some())
                .rev()
                .take(12)
                .map(|l| {
                    format!(
                        "{} {:?} {:?}",
                        super::super::ix_name(&l.wire, &r.c.program),
                        l.err,
                        l.logs.iter().rev().take(4).collect::<Vec<_>>()
                    )
                })
                .collect();
            panic!(
                "{what}: not reached in {secs} s (chain clock {}, bell {})\nlast failed program txs:\n{}\nkeeper log tail:\n{}",
                r.now(),
                r.bell(),
                fails.join("\n"),
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            );
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    r.lock().set_scale(1.0);
}

/// The war's two provinces: `(home, home_site, nation, target, keep, start_tile, dirs)`.
type Choice = (
    (i32, i32),
    u8,
    u8,
    (i32, i32),
    permutation_rules::frontier::keep::Keep,
    u8,
    Vec<u8>,
);

fn choose(r: &Run<'_>, plan: &[(i32, i32)]) -> Choice {
    let sd = r.season();
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    for &(hp, hq) in plan {
        let Some(nation) = home_nation(
            ProvinceCoord::new(hp, hq),
            cq.placement,
            cq.heartland_max_ring,
            &gseed,
        ) else {
            continue;
        };
        let Some(hv) = r.province_of(hp, hq) else {
            continue;
        };
        let pd = r.data(&r.c.a.province(hp, hq)).unwrap();
        let Some(site) = (0..pd[PV::SITE_COUNT] as usize).find(|i| {
            matches!(
                pd[PV::site(*i) + SM::STATE],
                SM::STATE_FREE | SM::STATE_RELEASED_FREE
            )
        }) else {
            continue;
        };
        let _ = &hv;
        if let Some((t, k, start, dirs)) = keep_target(r, plan, (hp, hq), nation) {
            return ((hp, hq), site as u8, nation, t, k, start, dirs);
        }
    }
    panic!("no rim province with a free site beside a contestable keep");
}

/// A contestable keep (held by another nation, not heartland-safe) in a province of `plan` reachable from `home` over
/// the two provinces' passable tiles: `(target, keep, start_tile, dirs)`.
pub(super) fn keep_target(
    r: &Run<'_>,
    plan: &[(i32, i32)],
    home: (i32, i32),
    nation: u8,
) -> Option<(
    (i32, i32),
    permutation_rules::frontier::keep::Keep,
    u8,
    Vec<u8>,
)> {
    let hv = r.province_of(home.0, home.1)?;
    for &(tp, tq) in plan {
        if (tp, tq) == home {
            continue;
        }
        let Some(tv) = r.province_of(tp, tq) else {
            continue;
        };
        let Some(k) = tv.cq.as_ref().and_then(|c| c.keep) else {
            continue;
        };
        if k.heartland_safe || k.holder == nation || k.holder >= 6 {
            continue;
        }
        if let Some((start, dirs)) =
            route(home, hv.passable_mask, (tp, tq), tv.passable_mask, k.tile)
        {
            return Some(((tp, tq), k, start, dirs));
        }
    }
    None
}

pub(super) async fn flow(r: &mut Run<'_>, plan: &[(i32, i32)], extra: Value) -> Value {
    let a = r.c.a.clone();
    let genesis_ts = r.clock().3;
    let ((hp, hq), site, nation, (tp, tq), keep0, start, dirs) = choose(r, plan);
    let mut beacon = Beacon {
        // (every region and every bell from the genesis: keeper A's beacon role works the bells in order, so a bell
        //  left without anchors anywhere would hold it before the arrival bell)
        regions: (0..r.season()[S::REGIONS]).collect(),
        staged: Default::default(),
        from_bell: 0,
    };
    let war_plan = json!({"home": [hp, hq], "site": site, "nation": nation, "target": [tp, tq], "keep": format!("{keep0:?}"),
        "route": {"start_tile": start, "dirs": dirs}});
    if let Some(pg) = r.c.page.clone() {
        if r.c.war.as_ref().is_some_and(|w| w.outage.is_some()) {
            return page::flow_home(r, &pg, plan, war_plan, extra).await;
        }
        return page::flow(r, &pg, plan, nation, war_plan, extra).await;
    }

    // 1. Join and the rim ticket; keeper A's tickets role settles it.
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
        240,
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
    // 2. Final, by the participant's Harvest.
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
        &[ix2::harvest(&a, &me, href)],
        &[&player],
        "participant",
    );
    assert_eq!(r.data(&holding).unwrap()[H::STATE], H::STATE_FINAL, "final");
    // 3. Declared: the reserve.
    let mut hd = r.lock().account(&holding).unwrap();
    let ro = H::reserve(0);
    hd.data[ro..ro + 4].copy_from_slice(&TROOPS.to_le_bytes());
    r.patch(
        holding,
        hd,
        &format!("{TROOPS} Spearmen in the rim village's reserve"),
    );
    // 4. keeper A's skip role makes the home resident; Muster.
    drive(
        r,
        &mut beacon,
        10.0,
        300,
        "keeper A resolves the home province to the current bell",
        |r| {
            r.province_of(hp, hq)
                .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);
    let h0 = Holding::decode(&r.data(&holding).unwrap()).unwrap();
    let host = fclient::addr::host_id(hp, hq, site, h0.gen, h0.host_seq).unwrap();
    let muster = r.send(
        &format!("Muster {TROOPS} onto tile {start}"),
        &[ix::muster(&a, &me, href, 0, TROOPS, start)],
        &[&player],
        "participant",
    );
    let muster_bell = r.bell();
    assert!(
        muster_bell < DEPART_BELL,
        "mustered at bell {muster_bell}: too late for the Depart at bell {DEPART_BELL}"
    );
    // the clock to the Depart bell, the home kept resident
    let depart_t = genesis_ts + 600 * DEPART_BELL as i64 + 30;
    // (fast to five minutes before the Depart bell, then slowly, so that the bell is not passed)
    drive(
        r,
        &mut beacon,
        40.0,
        1500,
        "five minutes before the Depart bell",
        |r| r.now() >= depart_t - 330,
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
                r.bell() <= DEPART_BELL,
                "the Depart bell {DEPART_BELL} passed before the home was resident"
            );
            r.now() >= depart_t
                && r.province_of(hp, hq)
                    .is_some_and(|v| fclient::play::resident_ok(v.resolved_next, r.bell()))
        },
    )
    .await;
    r.lock().set_paused(true);
    // 5. ONE sealed Depart onto the keep, sealed to T(21) under the real quicknet key.
    let sd = r.season();
    let season = fclient::decode::Season::decode(&sd).unwrap();
    let (path_len, path) = permutation_rules::frontier::seal::encode_path(&dirs).unwrap();
    let plain =
        permutation_rules::frontier::seal::pack(&permutation_rules::frontier::seal::Plain {
            version: permutation_rules::frontier::seal::PLAIN_VERSION,
            host_id: host,
            arrive_bell: ARRIVE_BELL,
            dest_p: tp as _,
            dest_q: tq as _,
            dest_tile: keep0.tile,
            stance: 0,
            retreat_bps: 0,
            path_len,
            path,
            reserved: Default::default(),
        });
    let sealed = fclient::seal::seal(
        &plain,
        &fclient::beacon::quicknet_info().public_key,
        ARRIVE_ROUND,
    )
    .unwrap();
    let tip = fclient::fees::min_tip_lamports(
        season.min_reveal_priority_milli,
        season.reveal_cu_limit,
        season.reveal_loaded_limit,
    );
    let args = ix::DepartArgs {
        host_id: host,
        commit: sealed.commit,
        seal: sealed.seal,
        arrive_bell: ARRIVE_BELL,
        tip,
        transit_slot: 0,
    };
    let since = r.lock().slot();
    let depart = r.send(
        &format!(
            "Depart onto the keep of ({tp}, {tq}) tile {}, arrival bell {ARRIVE_BELL}",
            keep0.tile
        ),
        &[ix2::depart(&a, &me, href, (hp as i16, hq as i16), &args)],
        &[&player],
        "participant",
    );
    let war = keeper_war(
        r,
        &mut beacon,
        (hp, hq),
        (tp, tq),
        holding,
        host,
        nation,
        since,
    )
    .await;
    let participant_txs = r.rows.clone();
    // (verify-pr118) the verifier judges the whole season: no FAIL
    let verifier = r.judge_season("p8");
    assert_eq!(
        verifier["fails"], 0,
        "the verifier FAILs the season: {verifier:#}"
    );
    json!({"verifier_season": verifier, "p8_war": "a test participant's legacy war on the devnet .so: rim village, Muster, ONE sealed Depart onto a keep; keeper A does the rest",
        "plan": war_plan, "muster": muster, "depart": depart, "keeper_war": war, "rows": participant_txs,
        "declared_patches": r.patches, "setup": extra})
}

/// After the Depart: keeper A settles the departure, anchors the arrival bell from the real round, reveals from the
/// public round (or the page's material), gathers, resolves, settles the transit, holds the keep and settles the
/// return. Nothing is sent here. → the keeper's war transactions and what was seen.
pub(super) async fn keeper_war(
    r: &mut Run<'_>,
    beacon: &mut Beacon,
    (hp, hq): (i32, i32),
    (tp, tq): (i32, i32),
    holding: Address,
    host: u64,
    nation: u8,
    since: u64,
) -> Value {
    use fclient::abi::tag as T;
    let ctx = r.ctx();
    let dest_region = ix::region_of(tp, tq);
    let keep_of = |r: &Run<'_>| {
        r.province_of(tp, tq)
            .and_then(|v| v.cq.and_then(|c| c.keep))
            .unwrap()
    };
    let keep0 = keep_of(r);
    let reserve0 = Holding::decode(&r.data(&holding).unwrap()).unwrap().reserve[0];
    // the arrival bell's REAL anchor (keeper A's beacon role, from the round drand-replay serves at T(21)'s time)
    let anchor = adr(ctx.bell_anchor(ARRIVE_BELL, dest_region));
    drive(
        r,
        beacon,
        10.0,
        1200,
        "keeper A posts THE anchor of the arrival bell from the real round T(21)",
        |r| r.data(&anchor).is_some(),
    )
    .await;
    let ad = r.data(&anchor).unwrap();
    let anchor_round = u64::from_le_bytes(ad[BA::ROUND..BA::ROUND + 8].try_into().unwrap());
    assert_eq!(
        anchor_round, ARRIVE_ROUND,
        "the arrival bell is anchored on the real round"
    );
    // the reveal (keeper A opens the seal from the public round), the clash, the settlement
    let slot = r.c.a.arrival_slot(tp, tq, ARRIVE_BELL, nation, 0);
    drive(
        r,
        beacon,
        4.0,
        900,
        "keeper A reveals the march (an ArrivalSlot of the arrival bell)",
        |r| r.data(&slot).is_some(),
    )
    .await;
    drive(
        r,
        beacon,
        6.0,
        900,
        "keeper A resolves the arrival bell (the clash)",
        |r| {
            r.province_of(tp, tq)
                .is_some_and(|v| v.resolved_next > ARRIVE_BELL)
        },
    )
    .await;
    let after_arrival = keep_of(r);
    let settled = |r: &Run<'_>| {
        Holding::decode(&r.data(&holding).unwrap()).is_ok_and(|h| h.transit[0].state == 0)
    };
    drive(
        r,
        beacon,
        6.0,
        900,
        "keeper A settles the transit (SettleTransit)",
        |r| settled(r),
    )
    .await;
    // the keep's held bells, the capture and the donor's return (as long as the Season's keep rules take)
    let last = ARRIVE_BELL + AFTER_BELLS;
    let mut taken: Option<Value> = None;
    let mut returned: Option<Value> = None;
    let entry_of = |r: &Run<'_>| {
        r.province_of(tp, tq)
            .and_then(|v| v.entries.into_iter().find(|e| e.id == host))
    };
    drive(
        r,
        beacon,
        40.0,
        3600,
        "the keep's bells: capture and return (or the bell limit)",
        |r| {
            let k = keep_of(r);
            if taken.is_none() && k.holder == nation {
                taken = Some(json!({"bell": r.bell(), "keep": format!("{k:?}")}));
            }
            let res = Holding::decode(&r.data(&holding).unwrap()).unwrap().reserve[0];
            if returned.is_none() && res > 0 && entry_of(r).is_none() {
                returned = Some(
                    json!({"bell": r.bell(), "reserve_before_war": reserve0, "reserve_after": res}),
                );
            }
            returned.is_some() || r.bell() > last
        },
    )
    .await;
    r.lock().set_paused(true);
    let rows = r.feed_rows(
        since,
        &[
            T::SETTLE_DEPARTURE,
            T::POST_ANCHOR,
            T::POST_ANCHOR_MULTI,
            T::REVEAL,
            T::GATHER_CLASH,
            T::RESOLVE_FROM_INPUTS,
            T::SKIP_QUIET,
            T::SETTLE_TRANSIT,
            T::SETTLE_CAPTURE,
            T::CLOSE_ARRIVAL_SLOT,
            T::CLOSE_ARRIVAL_DAY,
            T::CLOSE_CLASH_INPUTS,
            T::CLAIM_DEFENCE,
            T::FOLD_OCCUPANCY,
        ],
        "keeper A",
    );
    let landed = |tag: u8| {
        rows.iter()
            .filter(|x| x["tag"] == format!("0x{tag:02X}") && x["ok"] == true)
            .count()
    };
    for (tag, name) in [
        (T::SETTLE_DEPARTURE, "SettleDeparture"),
        (T::REVEAL, "Reveal"),
        (T::GATHER_CLASH, "GatherClash"),
        (T::RESOLVE_FROM_INPUTS, "ResolveFromInputs"),
        (T::SETTLE_TRANSIT, "SettleTransit"),
    ] {
        assert!(landed(tag) > 0, "keeper A landed no {name}: {rows:#?}");
    }
    let _ = (hp, hq);
    // keeper A's own counters of the play duty (its `/v1/status`)
    let play_status =
        r.c.war
            .as_ref()
            .and_then(|w| keeper_status(w.keeper_api, &w.token))
            .map(|s| s["play"].clone())
            .unwrap_or(Value::Null);
    json!({"keeper_play_status": play_status, "arrival_anchor_round": anchor_round, "keep_before": format!("{keep0:?}"), "keep_after_arrival": format!("{after_arrival:?}"),
        "keep_final": format!("{:?}", keep_of(r)), "taken": taken, "returned": returned, "keeper_txs": rows,
        "counts": {"settle_departure": landed(T::SETTLE_DEPARTURE), "reveal": landed(T::REVEAL), "gather": landed(T::GATHER_CLASH),
                   "resolve": landed(T::RESOLVE_FROM_INPUTS), "skip": landed(T::SKIP_QUIET), "settle_transit": landed(T::SETTLE_TRANSIT),
                   "settle_capture": landed(T::SETTLE_CAPTURE)}})
}

#[path = "war_page.rs"]
mod page;
