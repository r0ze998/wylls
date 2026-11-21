//! PFOG (fog-devnet): the fog of war on the DEVNET page path, offline, on the exact devnet `.so`.
//!
//! P9's war (player A — the web page — musters and sends ONE sealed Depart onto the keep of a neighbouring rim province;
//! keeper A reveals, resolves and settles it) with two more players of other nations, each looking through the devnet
//! page in headless Chromium (`page_fog_driver.mjs`, Wallet Standard TEST wallets on `solana:devnet`):
//!
//! - **B** joins the nation that HOLDS the target keep and founds a rim village in another province of that nation: the
//!   keep is B's nation's territory (map/fog.mjs: a held province sees itself and 2 tiles beyond), so A's march enters
//!   B's vision when it arrives at the keep;
//! - **C** joins a third nation and founds its village in the rim province farthest from A's home, the keep and every
//!   keep C's nation holds: nothing of the war is in C's vision.
//!
//! B's and C's Join and FileTicket are sent here with TEST keys (as P8's test participant); keeper A's `tickets` role
//! settles them. The observers send nothing. At four points — `start` (all three villages stand), `departed` (A's Depart
//! landed, bell 19), `settled` (SettleTransit: A's host stands on the keep) and `final` (after the keep's bells) —
//! every page (A's through its driver's inspection listener) writes what its survey says of the focus places, the RAW
//! herald records beside the FOGGED copies its surfaces read, the chronicle's DEPART / CLASH records raw vs told, the
//! clash report gate, the keep lists, the spectate links and the 「記録」 button, with stills of the map and 全体図.
//! [`verdict`] checks them against the owner's fog rules.
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

/// Province distance (axial `p, q`).
fn pdist(a: (i32, i32), b: (i32, i32)) -> i32 {
    let (dp, dq) = (a.0 - b.0, a.1 - b.1);
    (dp.abs() + dq.abs() + (dp + dq).abs()) / 2
}

pub struct Obs {
    driver: KillChild,
    sync: PathBuf,
    pub(super) plan: Value,
    snaps: serde_json::Map<String, Value>,
    nations: (u8, u8, u8),
    a_host: Option<u64>,
}

struct Observer {
    key: Keypair,
    nation: u8,
    home: (i32, i32),
    site: u8,
    tile: u8,
}

fn free_site(r: &Run<'_>, p: i32, q: i32) -> Option<u8> {
    let pd = r.data(&r.c.a.province(p, q))?;
    (0..pd[PV::SITE_COUNT] as usize)
        .find(|i| {
            matches!(
                pd[PV::site(*i) + SM::STATE],
                SM::STATE_FREE | SM::STATE_RELEASED_FREE
            )
        })
        .map(|i| i as u8)
}

/// Chooses, founds and opens the two observers; returns once both pages show their village under the fog.
#[allow(clippy::too_many_arguments)]
pub(super) async fn setup(
    r: &mut Run<'_>,
    pg: &Page,
    plan: &[(i32, i32)],
    beacon: &mut Beacon,
    sync: &std::path::Path,
    a: (i32, i32, u8, u8),
    a_nation: u8,
    target: (i32, i32),
    keep: &permutation_rules::frontier::keep::Keep,
    start: u8,
) -> Obs {
    let (hp, hq, _a_site, a_tile) = a;
    let (tp, tq) = target;
    let sd = r.season();
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let gseed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let nation_of = |p: i32, q: i32| {
        home_nation(
            ProvinceCoord::new(p, q),
            cq.placement,
            cq.heartland_max_ring,
            &gseed,
        )
    };
    let holder_of = |r: &Run<'_>, p: i32, q: i32| {
        r.province_of(p, q)
            .and_then(|v| v.cq.and_then(|c| c.keep))
            .map(|k| k.holder)
    };
    // B: preferably a village IN the keep's province, on the free site nearest the keep tile and within a hamlet's sight
    // of it (map/survey.mjs SIGHT.village(0) = 4), of that province's nation — so the keep is in B's own vision (run1:
    // the keep's holder nation did not count the rim keep as its territory on the page, and a far village of that
    // nation never saw it). Else a province of the keep's holder nation, as far from A's home as possible.
    let tile_dist = |a: u8, b: u8| {
        let (Some(x), Some(y)) = (tile_offset(a), tile_offset(b)) else {
            return i32::MAX;
        };
        let (dq, dr) = (x.q - y.q, x.r - y.r);
        (dq.abs() + dr.abs() + (dq + dr).abs()) / 2
    };
    let in_keep = nation_of(tp, tq)
        .filter(|n| *n != a_nation && *n < 6)
        .and_then(|n| {
            let pd = r.data(&r.c.a.province(tp, tq))?;
            let v = r.province_of(tp, tq)?;
            (0..pd[PV::SITE_COUNT] as usize)
                .filter(|i| {
                    matches!(
                        pd[PV::site(*i) + SM::STATE],
                        SM::STATE_FREE | SM::STATE_RELEASED_FREE
                    )
                })
                .map(|i| (tile_dist(v.sites[i], keep.tile), i as u8, v.sites[i]))
                .filter(|(d, _, _)| *d <= 4)
                .min()
                .map(|(d, site, tile)| (n, site, tile, d))
        });
    let y = in_keep.map(|x| x.0).unwrap_or(keep.holder);
    assert!(
        y < 6 && y != a_nation,
        "the observer B's nation {y} is another nation"
    );
    let (bp, bq) = if in_keep.is_some() {
        (tp, tq)
    } else {
        plan.iter()
            .copied()
            .filter(|&(p, q)| {
                (p, q) != (tp, tq)
                    && (p, q) != (hp, hq)
                    && nation_of(p, q) == Some(y)
                    && free_site(r, p, q).is_some()
            })
            .max_by_key(|&c| pdist(c, (hp, hq)))
            .unwrap_or_else(|| panic!("no rim province of the keep's nation {y} with a free site"))
    };
    // C: a third nation Z and a province of Z maximising the distance of C's home AND of every keep Z holds from A's
    // home and the keep
    let mut best: Option<(i32, u8, (i32, i32))> = None;
    for z in (0..6u8).filter(|z| *z != a_nation && *z != y) {
        let held: Vec<(i32, i32)> = plan
            .iter()
            .copied()
            .filter(|&(p, q)| holder_of(r, p, q) == Some(z))
            .collect();
        for &(p, q) in plan {
            if nation_of(p, q) != Some(z) || free_site(r, p, q).is_none() {
                continue;
            }
            let score = held
                .iter()
                .chain(std::iter::once(&(p, q)))
                .map(|&c| pdist(c, (hp, hq)).min(pdist(c, (tp, tq))))
                .min()
                .unwrap_or(i32::MAX);
            if best.map_or(true, |b| score > b.0) {
                best = Some((score, z, (p, q)));
            }
        }
    }
    let (c_score, z, (cp, cq_)) = best.expect("a third nation's rim province with a free site");
    let mk = |r: &Run<'_>, nation: u8, (p, q): (i32, i32)| {
        let site = free_site(r, p, q).unwrap();
        let tile = r.province_of(p, q).unwrap().sites[site as usize];
        Observer {
            key: Keypair::new(), // TEST key (this chain only)
            nation,
            home: (p, q),
            site,
            tile,
        }
    };
    let mut obs_b = mk(r, y, (bp, bq));
    if let Some((_, site, tile, _)) = in_keep {
        obs_b.site = site;
        obs_b.tile = tile;
    }
    let obs_c = mk(r, z, (cp, cq_));
    let ca = r.c.a.clone();
    for (who, o) in [("B", &obs_b), ("C", &obs_c)] {
        let w = o.key.pubkey();
        r.lock().airdrop(&w, 5 * SOL).unwrap();
        let now = r.now();
        r.send(
            &format!("Join (observer {who}, nation {})", o.nation),
            &[ix::join(&ca, w, w, o.nation, &w, now + 30 * 86_400, None)],
            &[&o.key],
            &format!("observer {who}"),
        );
        let me = ix::Player {
            actor: w,
            payer: w,
            wallet: w,
        };
        r.send(
            &format!(
                "FileTicket(observer {who}: rim {}, {} site {})",
                o.home.0, o.home.1, o.site
            ),
            &[ix::file_ticket(
                &ca,
                &me,
                &[ix::Site {
                    p: o.home.0 as i16,
                    q: o.home.1 as i16,
                    site: o.site,
                }],
            )],
            &[&o.key],
            &format!("observer {who}"),
        );
        let seed = sync.join(format!("observer-{who}.seed"));
        std::fs::write(&seed, hex::encode(&o.key.to_bytes()[..32])).unwrap();
        std::fs::set_permissions(&seed, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let hb = ca.holding(bp, bq, obs_b.site);
    let hc = ca.holding(cp, cq_, obs_c.site);
    drive(
        r,
        beacon,
        2.0,
        900,
        "keeper A settles the observers' rim tickets",
        |r| {
            let l = r.lock();
            l.account(&hb).is_some_and(|h| h.owner == r.c.program)
                && l.account(&hc).is_some_and(|h| h.owner == r.c.program)
        },
    )
    .await;
    let k = |p: i32, q: i32, t: u8| json!({"p": p, "q": q, "tile": t});
    let focus = json!({
        "aOrigin": k(hp, hq, start), "aVillage": k(hp, hq, a_tile), "keep": k(tp, tq, keep.tile),
        "bVillage": k(bp, bq, obs_b.tile), "cVillage": k(cp, cq_, obs_c.tile),
    });
    let out = pg.out.join("fog");
    std::fs::create_dir_all(&out).unwrap();
    let driver = KillChild(
        std::process::Command::new("node")
            .arg(pg.driver.parent().unwrap().join("page_fog_driver.mjs"))
            .args([
                "--url",
                &format!("http://127.0.0.1:{}/frontier/frontier/", pg.herald),
                "--out",
                out.to_str().unwrap(),
                "--sync",
                sync.to_str().unwrap(),
                "--seed-b",
                sync.join("observer-B.seed").to_str().unwrap(),
                "--seed-c",
                sync.join("observer-C.seed").to_str().unwrap(),
                "--a-inspect",
                &pg.inspect.to_string(),
                "--focus",
                &focus.to_string(),
            ])
            .stdout(std::fs::File::create(out.join("fog-driver.out.log")).unwrap())
            .stderr(std::fs::File::create(out.join("fog-driver.err.log")).unwrap())
            .spawn()
            .expect("node (the fog observer driver)"),
    );
    let plan_v = json!({
        "A": {"nation": a_nation, "home": [hp, hq], "village_tile": a_tile, "march_origin_tile": start},
        "keep": {"p": tp, "q": tq, "tile": keep.tile, "holder": y},
        "B": {"wallet": obs_b.key.pubkey().to_string(), "nation": y, "home": [bp, bq], "site": obs_b.site, "tile": obs_b.tile,
              "province_distance_from_A": pdist((bp, bq), (hp, hq)), "province_distance_from_keep": pdist((bp, bq), (tp, tq)),
              "in_keep_province": in_keep.is_some(), "tile_distance_to_keep_tile": in_keep.map(|x| x.3), "keep_holder": keep.holder},
        "C": {"wallet": obs_c.key.pubkey().to_string(), "nation": z, "home": [cp, cq_], "site": obs_c.site, "tile": obs_c.tile,
              "min_province_distance_of_C_and_its_nation_keeps_from_A_and_keep": c_score},
        "focus": focus,
    });
    let mut o = Obs {
        driver,
        sync: sync.to_path_buf(),
        plan: plan_v,
        snaps: Default::default(),
        nations: (a_nation, y, z),
        a_host: None,
    };
    // (the pages read, connect and show their village; the clock runs slowly meanwhile)
    let t0 = Instant::now();
    while !o.sync.join("fog-ready.json").exists() {
        assert!(
            !o.sync.join("fog-failed.txt").exists(),
            "the fog driver failed: {}",
            std::fs::read_to_string(o.sync.join("fog-failed.txt")).unwrap_or_default()
        );
        assert!(
            o.driver.0.try_wait().ok().flatten().is_none(),
            "the fog driver exited before its observers were ready"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(1200),
            "the observers' pages never showed their villages under the fog"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    snap(r, &mut o, beacon, "start").await;
    o
}

impl Obs {
    pub(super) fn host(&mut self, host: u64) {
        self.a_host = Some(host);
    }
}

/// One snapshot of all three pages (the clock runs at 1× while they look; `wait_hosts`: the pages first wait — at most
/// 90 s each — for the herald's record of that province to show that nation's host).
pub(super) async fn snap(r: &mut Run<'_>, o: &mut Obs, beacon: &mut Beacon, label: &str) {
    snap_with(r, o, beacon, label, None).await
}
pub(super) async fn snap_with(
    r: &mut Run<'_>,
    o: &mut Obs,
    beacon: &mut Beacon,
    label: &str,
    wait_hosts: Option<(i32, i32, u8)>,
) {
    // (a few seconds of running clock first: the herald's index and the pages' polls catch up with what just landed)
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(25) {
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    std::fs::write(
        o.sync.join(format!("fog-go-{label}.json")),
        json!({"bell": r.bell(), "waitHosts": wait_hosts.map(|(p, q, f)| json!({"p": p, "q": q, "faction": f}))}).to_string(),
    )
    .unwrap();
    let t0 = Instant::now();
    while !o.sync.join(format!("fog-done-{label}.json")).exists() {
        assert!(
            o.driver.0.try_wait().ok().flatten().is_none() || label == "final",
            "the fog driver exited during snapshot {label}"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(900),
            "snapshot {label} not done"
        );
        beacon.tick(r);
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    let mut all = serde_json::Map::new();
    for who in ["A", "B", "C"] {
        let v = std::fs::read_to_string(o.sync.join(format!("fog-{who}-{label}.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .unwrap_or(Value::Null);
        all.insert(who.into(), v);
    }
    all.insert("chain_bell".into(), json!(r.bell()));
    o.snaps.insert(label.into(), Value::Object(all));
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
}

/// The owner's fog rules, checked on every snapshot: `(summary, failures)`.
pub(super) fn verdict(o: &mut Obs, out: &std::path::Path) -> Value {
    let (xa, _y, _z) = o.nations;
    let host = o.a_host.map(|h| h.to_string());
    let mut fails: Vec<String> = vec![];
    let mut checks = 0usize;
    let mut ok = |c: bool, what: String, fails: &mut Vec<String>| {
        checks += 1;
        if !c {
            fails.push(what);
        }
    };
    let lv = |s: &Value, place: &str| s["places"][place]["level"].as_u64();
    let mut table = vec![];
    for (label, snap) in &o.snaps {
        for who in ["A", "B", "C"] {
            let s = &snap[who];
            if s.is_null() {
                fails.push(format!("{label}/{who}: no snapshot"));
                continue;
            }
            let at = format!("{label}/{who}");
            ok(
                s["fogMode"] == "devnet" && s["fogOn"] == true && s["cluster"] == "devnet",
                format!("{at}: the devnet fog is on"),
                &mut fails,
            );
            ok(
                s["spectateLinks"] == 0,
                format!("{at}: no spectate link"),
                &mut fails,
            );
            ok(
                s["recordSheetButton"] == false,
                format!("{at}: no 「記録」 sheet"),
                &mut fails,
            );
            let wallet = s["wallet"].as_str().unwrap_or("?");
            ok(
                s["fogMemoryKeys"].as_array().is_some_and(|k| {
                    k.iter().any(|x| {
                        x.as_str().is_some_and(|x| {
                            x.starts_with("ps-ffog:v1:devnet:")
                                && x.contains('@')
                                && x.ends_with(wallet)
                        })
                    })
                }),
                format!("{at}: the last-known memory is keyed by season + wallet"),
                &mut fails,
            );
            // unseen places show nothing
            for (place, p) in s["places"].as_object().into_iter().flatten() {
                if p["shown"]["fog"] == "unseen" {
                    ok(
                        p["shown"]["owners"]
                            .as_array()
                            .is_some_and(|a| a.iter().all(|x| x == 7))
                            && p["shown"]["hosts"]
                                .as_array()
                                .is_some_and(|a| a.iter().all(|x| x == 0))
                            && p["shown"]["clash"] == false
                            && p["shown"]["control"].is_null(),
                        format!("{at}: never-seen {place} is blank"),
                        &mut fails,
                    );
                }
            }
            // A's march: told to B and C exactly when its origin tile is in sight now
            let origin_seen = lv(s, "aOrigin") == Some(3);
            for c in s["chronicle"].as_array().into_iter().flatten() {
                if c["name"] == "DEPART"
                    && host.as_deref().is_some_and(|h| c["host"] == h)
                    && who != "A"
                {
                    ok(
                        c["told"] == origin_seen,
                        format!(
                            "{at}: A's departure told iff its origin is in sight ({origin_seen})"
                        ),
                        &mut fails,
                    );
                }
            }
            // the clash report at the keep: offered exactly when the keep tile is in sight now
            ok(
                s["clashAtKeep"]["offered"] == (s["clashAtKeep"]["keepTileLevel"] == 3),
                format!("{at}: the keep's clash report follows its keep tile's sight"),
                &mut fails,
            );
            let k = &s["places"]["keep"];
            let shown_a_hosts = k["shown"]["hosts"][xa as usize].as_u64().unwrap_or(0);
            let raw_a_hosts = k["raw"]["hosts"][xa as usize].as_u64().unwrap_or(0);
            if who != "A" && k["province"] != "sight" {
                ok(
                    shown_a_hosts == 0,
                    format!("{at}: A's host at the keep is not shown out of sight"),
                    &mut fails,
                );
            }
            table.push(json!({"snap": label, "who": who, "bell": s["bell"], "faction": s["faction"],
                "origin_level": lv(s, "aOrigin"), "keep_tile_level": s["clashAtKeep"]["keepTileLevel"], "keep_province": k["province"],
                "a_hosts_at_keep_raw": raw_a_hosts, "a_hosts_at_keep_shown": shown_a_hosts,
                "departure_raw": s["chronicle"].as_array().map(|c| c.iter().filter(|c| c["name"] == "DEPART").count()),
                "departure_told": s["chronicle"].as_array().map(|c| c.iter().filter(|c| c["name"] == "DEPART" && c["told"] == true).count()),
                "clash_raw": s["chronicle"].as_array().map(|c| c.iter().filter(|c| c["name"] == "CLASH").count()),
                "clash_told": s["chronicle"].as_array().map(|c| c.iter().filter(|c| c["name"] == "CLASH" && c["told"] == true).count()),
                "clash_offered": s["clashAtKeep"]["offered"],
                "keeps_raw": s["keeps"]["raw"].as_array().map(|a| a.len()), "keeps_shown": s["keeps"]["shown"],
                "places_shown_fog": s["places"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v["shown"]["fog"].clone())).collect::<serde_json::Map<_, _>>()),
                "stills": s["stills"]}));
        }
    }
    // the scenario's own claims
    let get = |label: &str, who: &str| {
        o.snaps
            .get(label)
            .map(|s| s[who].clone())
            .unwrap_or(Value::Null)
    };
    let settled_b = get("settled", "B");
    let start_b = get("start", "B");
    let settled_c = get("settled", "C");
    let raw_b = settled_b["places"]["keep"]["raw"]["hosts"][xa as usize]
        .as_u64()
        .unwrap_or(0);
    ok(
        raw_b > 0,
        "settled/B: the herald's record has A's host on the keep (the raw data is there)".into(),
        &mut fails,
    );
    ok(
        settled_b["places"]["keep"]["shown"]["hosts"][xa as usize]
            .as_u64()
            .unwrap_or(0)
            > 0,
        "settled/B: A's march entered B's vision (its nation's keep): its host is shown".into(),
        &mut fails,
    );
    ok(
        start_b["places"]["keep"]["shown"]["hosts"][xa as usize]
            .as_u64()
            .unwrap_or(0)
            == 0,
        "start/B: no host of A's at the keep before the march".into(),
        &mut fails,
    );
    for label in ["start", "departed", "settled", "final"] {
        let c = get(label, "C");
        ok(
            c["clashAtKeep"]["offered"] == false,
            format!("{label}/C: the keep's clash is outside C's vision"),
            &mut fails,
        );
        ok(
            c["chronicle"].as_array().is_some_and(|l| {
                l.iter()
                    .filter(|x| x["told"] == true)
                    .all(|x| x["mine"] == true)
            }),
            format!("{label}/C: no other player's march or clash is told to C"),
            &mut fails,
        );
        for place in ["aOrigin", "aVillage", "keep"] {
            ok(
                c["places"][place]["shown"].is_null()
                    || c["places"][place]["shown"]["fog"] == "unseen",
                format!("{label}/C: {place} never seen (blank on the map and 全体図)"),
                &mut fails,
            );
        }
        let a = get(label, "A");
        ok(
            a["places"]["cVillage"]["shown"].is_null()
                || a["places"]["cVillage"]["shown"]["fog"] == "unseen",
            format!("{label}/A: C's province never seen"),
            &mut fails,
        );
    }
    ok(
        settled_c["places"]["keep"]["shown"]["hosts"][xa as usize]
            .as_u64()
            .unwrap_or(0)
            == 0,
        "settled/C: A's host at the keep is not shown to C".into(),
        &mut fails,
    );
    // the observers sent nothing
    for who in ["B", "C"] {
        let posts = std::fs::read_to_string(out.join("fog").join(who).join("posts.log"))
            .unwrap_or_default();
        ok(
            !posts.contains("/gw/f/devnet-play/"),
            format!("{who} sent no devnet play command"),
            &mut fails,
        );
    }
    let summary = json!({"plan": o.plan, "checks": checks, "failures": fails, "table": table, "snapshots": Value::Object(o.snaps.clone())});
    std::fs::write(
        out.join("fog").join("fog-summary.json"),
        serde_json::to_string_pretty(&summary).unwrap(),
    )
    .unwrap();
    summary
}

/// The last snapshot; then the driver is gone.
pub(super) async fn finish(
    r: &mut Run<'_>,
    mut o: Obs,
    beacon: &mut Beacon,
    out: &std::path::Path,
) -> Value {
    snap(r, &mut o, beacon, "final").await;
    let _ = o.driver.0.wait();
    let v = verdict(&mut o, out);
    v
}
