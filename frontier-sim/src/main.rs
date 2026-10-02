//! Frontier host balance simulator (open-world design §12 M0).
//!
//! ```text
//! frontier-sim run   [--agents N] [--seed S] [--sizes 3,1,1,1,1,1] [--bots 0.05]
//!                    [--doctrines] [--rotation K] [--gamma 3/5] [--day0 0.6]
//! frontier-sim suite [--agents N] [--seeds K] [--out PATH]
//! frontier-sim doctrines [--agents N] [--seeds K] [--set kernel|draft|m0]
//!                    [--dx "C.arrival=10500,D.drill=10500"] [--unpaired]
//!                    [--first-seed N] [--gate]
//!                    [--gate-index 0.12]   (exit 1 if a mean index is off by more)
//! frontier-sim doctrine-gate [--set kernel|draft|m0] [--controls]
//!                    (the CI gate's harness; --controls: the negative controls must fail)
//! frontier-sim criterion [--seeds K] [--first-seed N] [--rev2-economy] [economy knobs]
//!                    (bot criterion, O4; seeds N+1..=N+K, default N = 200)
//! frontier-sim c4 [--agents 50000] [--seeds K] [--first-seed N] [--out PATH]
//!                    (restated C4: per-bell participation, tail episodes and
//!                    the counterfactual value of one attacked bell)
//! frontier-sim criterion --best-response [--seeds K] [--first-seed N] [--gate]
//!                    (the criterion as the max over the bot's join window,
//!                    stake and office choices; exit 1 with --gate if any ≥ 1.0;
//!                    CL-16: `--first-seed 30001` is the held-out set)
//! frontier-sim c4 ... [--relics]
//!                    (c4 v3, CL-26/CL-30: the per-bell write counts and R99;
//!                    the 600/1,200-s window, relic-tip and D18 pool tables are
//!                    computed from its JSON by the lab scripts c4_model_v3.py
//!                    and d18_model.py, scratchpad/frontier/m1/lab/{c4-v3,d18})
//! ```
//!
//! `run` plays one season and prints its report; `suite` runs every M0
//! measurement and writes the markdown results.

mod balance;
mod c4;
mod config;
mod conquest;
#[cfg(test)]
mod cq_close_tests;
#[cfg(test)]
mod cq_tests;
mod mapmove;
mod mc;
mod model;
mod report;
mod rng;
mod settle;
mod sim;
mod suite;
mod w1c_shim;

use config::Config;
use permutation_rules::frontier::index::IndexParams;

fn parse_gamma(s: &str) -> IndexParams {
    let (n, d) = s.split_once('/').unwrap_or((s, "1"));
    IndexParams {
        gamma_num: n.parse().expect("gamma numerator"),
        gamma_den: d.parse().expect("gamma denominator"),
        ..IndexParams::REV2
    }
}

/// `--policy lone|campaign|campaign:0,lone:1-5` (faction lists and ranges).
fn parse_policy(v: &str) -> [mc::Policy; 6] {
    let one = |s: &str| match s {
        "lone" => mc::Policy::Lone,
        "campaign" => mc::Policy::Campaign,
        x => panic!("--policy {x}"),
    };
    if !v.contains(':') {
        return [one(v); 6];
    }
    let mut out = [mc::Policy::Lone; 6];
    for part in v.split(',') {
        let (p, fs) = part.split_once(':').expect("--policy name:factions");
        let (lo, hi) = fs.split_once('-').unwrap_or((fs, fs));
        let (lo, hi): (usize, usize) = (lo.parse().expect("faction"), hi.parse().expect("faction"));
        for x in out.iter_mut().take(hi + 1).skip(lo) {
            *x = one(p);
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("run");
    let mut cfg = Config::default();
    let mut seeds = 3u64;
    let mut out: Option<String> = None;
    let mut only: Option<String> = None;
    let mut paired = true;
    let mut gate = false;
    let mut first_seed: Option<u64> = None;
    let mut best = false;
    let mut gate_index: Option<f64> = None;
    let mut controls = false;
    let mut rules: Option<mc::Rules> = None;
    let mut preset: Option<mc::McParams> = None;
    let mut json: Option<String> = None;
    let mut check: Option<String> = None;
    let mut thresholds: Option<String> = None;
    let mut leader_max: Option<f64> = None;
    let mut report_only = false;
    let mut gate28 = false;
    let mut i = 2;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--agents" => cfg.agents = v.parse().expect("--agents"),
            "--seed" => cfg.seed = v.parse().expect("--seed"),
            "--seeds" => seeds = v.parse().expect("--seeds"),
            "--bots" => cfg.bot_share = v.parse().expect("--bots"),
            "--day0" => cfg.day0_share = v.parse().expect("--day0"),
            "--rotation" => cfg.doctrine_rotation = v.parse().expect("--rotation"),
            "--bot-q" => cfg.bot_q = Some(v.parse().expect("--bot-q")),
            "--bot-aggression" => cfg.bot_aggression = Some(v.parse().expect("--bot-aggression")),
            "--works-cap" => cfg.works_cap = v.parse().expect("--works-cap"),
            "--gamma" => cfg.index = parse_gamma(&v),
            "--works-per-usdc" => cfg.payout.works_per_usdc = v.parse().expect("--works-per-usdc"),
            "--stake-ramp" => cfg.stake_ramp_bps = v.parse().expect("--stake-ramp"),
            "--office-ceiling" => {
                cfg.payout.office_ceiling_bps = if v == "none" {
                    u32::MAX
                } else {
                    v.parse().expect("--office-ceiling")
                }
            }
            "--office-pay" => {
                cfg.office_pay = match v.split_once(':') {
                    Some(("share", b)) => config::OfficePay::ShareOfPaid(b.parse().expect("bps")),
                    _ if v == "usdc" => config::OfficePay::Usdc,
                    _ if v == "laurels" => config::OfficePay::Laurels,
                    _ => panic!("--office-pay {v}"),
                }
            }
            "--out" => out = Some(v),
            "--only" => only = Some(v),
            "--sizes" => {
                let w: Vec<u32> = v.split(',').map(|x| x.parse().expect("--sizes")).collect();
                cfg.faction_weights.copy_from_slice(&w[..6]);
            }
            "--set" => {
                cfg.doctrines = true;
                cfg.doctrine_set = model::DoctrineSet::parse(&v);
            }
            "--dx" => {
                cfg.doctrines = true;
                cfg.doctrine_tweaks = v;
            }
            "--first-seed" => first_seed = Some(v.parse().expect("--first-seed")),
            "--unpaired" => {
                paired = false;
                i += 1;
                continue;
            }
            "--gate-index" => gate_index = Some(v.parse().expect("--gate-index")),
            "--controls" => {
                controls = true;
                i += 1;
                continue;
            }
            "--best-response" => {
                best = true;
                i += 1;
                continue;
            }
            "--bot-mandates" => cfg.bot_mandates = Some(v.parse().expect("--bot-mandates")),
            "--office-term-limit" => {
                cfg.office_term_limit = if v == "none" {
                    None
                } else {
                    Some(v.parse().expect("--office-term-limit"))
                }
            }
            "--relic-to-mandate" => {
                cfg.relic_to_mandate = true;
                i += 1;
                continue;
            }
            "--bot-join-days" => {
                let (lo, hi) = v.split_once('-').unwrap_or((&v, &v));
                cfg.bot_join_days = Some((lo.parse().expect("day"), hi.parse().expect("day")));
            }
            "--gate" => {
                gate = true;
                i += 1;
                continue;
            }
            "--doctrines" => {
                cfg.doctrines = true;
                i += 1;
                continue;
            }
            "--emission" => {
                cfg.emission = match v.as_str() {
                    "full" => config::Emission::Full,
                    "first-only" => config::Emission::FirstOnly,
                    "order-weighted" => config::Emission::OrderWeighted,
                    x => panic!("--emission {x}"),
                }
            }
            "--late-stake" => {
                cfg.late_stake = match v.as_str() {
                    "none" => config::LateStake::None,
                    "bots" => config::LateStake::Bots,
                    "stakers" => config::LateStake::Stakers,
                    x => panic!("--late-stake {x}"),
                }
            }
            "--bot-officers" => {
                cfg.bot_officers = true;
                i += 1;
                continue;
            }
            "--no-mandate-floor" => {
                cfg.mandate_floor = false;
                i += 1;
                continue;
            }
            "--mandate-all" => {
                cfg.mandate_stakers_only = false;
                i += 1;
                continue;
            }
            "--relics" => {
                cfg.relics = true;
                i += 1;
                continue;
            }
            "--rev2-economy" => {
                cfg.set_rev2_economy();
                i += 1;
                continue;
            }
            "--no-relics" => {
                cfg.relics = false;
                i += 1;
                continue;
            }
            "--cq" => cfg.cq.apply(&v),
            "--rules" => {
                let mut parts = v.split(',');
                rules = Some(match parts.next().unwrap_or("") {
                    "m1" => mc::Rules::M1,
                    "mc" => mc::Rules::Mc,
                    "mc-weightmap" => mc::Rules::McWeightmap,
                    x => panic!("--rules {x}"),
                });
                for p in parts {
                    match p.split_once('=') {
                        Some(("bannerdom", n)) => cfg.bannerdom = n.parse().expect("bannerdom"),
                        None if p == "bannerdom" => cfg.bannerdom = 1,
                        None if p == "keepdom" => cfg.keepdom = true,
                        _ => panic!("--rules modifier {p}"),
                    }
                }
            }
            "--preset" => preset = Some(mc::McParams::parse(&v)),
            "--mc" => cfg.mc_overrides = v,
            "--policy" => cfg.policy = parse_policy(&v),
            "--bot-profile" => {
                cfg.bot_profile = match v.as_str() {
                    "sim" => mc::BotProfile::Sim,
                    "cq" => mc::BotProfile::Cq,
                    "m1" => mc::BotProfile::M1,
                    x => panic!("--bot-profile {x}"),
                }
            }
            "--m1-act-p" => cfg.m1_act_p = v.parse().expect("--m1-act-p"),
            "--keep-aggr" => cfg.cq.keep_aggr = v.parse().expect("--keep-aggr"),
            "--threads" => cfg.threads = Some(v.parse().expect("--threads")),
            "--json" => json = Some(v),
            "--check" => check = Some(v),
            "--thresholds" => thresholds = Some(v),
            "--check-leader-max" => leader_max = Some(v.parse().expect("--check-leader-max")),
            "--forward" => {
                cfg.forward = true;
                i += 1;
                continue;
            }
            "--keep-stay" => {
                cfg.keep_stay = true;
                i += 1;
                continue;
            }
            "--report-only" => {
                report_only = true;
                i += 1;
                continue;
            }
            "--gate-28d" => {
                gate28 = true;
                i += 1;
                continue;
            }
            "--days" => cfg.days = v.parse().expect("--days"),
            "--verbose" => {
                cfg.verbose = true;
                i += 1;
                continue;
            }
            other => panic!("unknown argument {other}"),
        }
        i += 2;
    }
    if let Some(r) = rules {
        cfg.set_rules(r, preset);
    } else if let Some(p) = preset {
        cfg.mc = p;
    }
    match cmd {
        "run" => {
            let t = std::time::Instant::now();
            let (sim, o) = suite::play(&cfg);
            println!("{}", suite::run_report(&sim, &o, t.elapsed().as_secs_f64()));
        }
        "suite" => {
            let text = suite::suite(&cfg, seeds, only.as_deref());
            match out {
                Some(p) => {
                    std::fs::write(&p, &text).expect("write results");
                    eprintln!("wrote {p}");
                }
                None => println!("{text}"),
            }
        }
        "doctrines" => {
            let spec = balance::Spec {
                agents: cfg.agents,
                seeds,
                first_seed: first_seed.unwrap_or(0),
                set: cfg.doctrine_set,
                tweaks: cfg.doctrine_tweaks.clone(),
                paired,
            };
            let b = balance::run(&cfg, &spec);
            let text = balance::table(&b);
            match out {
                Some(p) => {
                    std::fs::write(&p, &text).expect("write results");
                    eprintln!("wrote {p}");
                }
                None => println!("{text}"),
            }
            if gate && b.in_band < 6 {
                eprintln!("gate failed: {} of 6 doctrines in the band", b.in_band);
                std::process::exit(1);
            }
            if let Some(x) = gate_index {
                if let Err(e) = balance::gate_check_with(&b, x, 100.0) {
                    eprintln!("index gate failed: {e}");
                    std::process::exit(1);
                }
            }
        }
        "doctrine-gate" => {
            let b = balance::gate_run_base(&cfg, cfg.doctrine_set, "", balance::GATE_SEEDS);
            println!("rules {} (policy {:?})\n", cfg.rules.name(), cfg.policy[0]);
            println!("{}", balance::table(&b));
            if let Err(e) = balance::gate_check(&b) {
                if report_only {
                    println!("gate verdict (report only): FAIL: {e}");
                } else {
                    eprintln!("gate failed: {e}");
                    std::process::exit(1);
                }
            } else if report_only {
                println!("gate verdict (report only): PASS");
            }
            if controls {
                // The negative controls must each fail the gate.
                for (name, set, dx, seeds) in [
                    (
                        "draft",
                        model::DoctrineSet::Draft,
                        "",
                        balance::GATE_DRAFT_SEEDS,
                    ),
                    (
                        "Knight",
                        model::DoctrineSet::Kernel,
                        balance::GATE_KNIGHT,
                        balance::GATE_SEEDS,
                    ),
                    (
                        "A boost",
                        model::DoctrineSet::Kernel,
                        balance::GATE_A_BOOST,
                        balance::GATE_SEEDS,
                    ),
                ] {
                    let b = balance::gate_run_base(&cfg, set, dx, seeds);
                    println!("### control: {name}\n\n{}", balance::table(&b));
                    match balance::gate_check(&b) {
                        Err(e) => println!("control {name} rejected as it must be: {e}\n"),
                        Ok(()) => {
                            eprintln!(
                                "control {name} PASSED the gate: the gate has lost its power"
                            );
                            std::process::exit(1);
                        }
                    }
                }
            }
        }
        "criterion" if best => {
            let rows = suite::criterion_best(
                &cfg,
                seeds,
                first_seed.unwrap_or(suite::CRITERION_FIRST_SEED),
                &[false, true],
            );
            let (text, worst) = suite::criterion_best_table(&rows);
            println!("{text}");
            let mut fail = worst >= 1.0;
            if cfg.rules.mc() {
                // W1-close, PO-8, CQH2: under MC the gate is an absolute
                // ceiling on the worst cell (≤ 0.995 on the gate seeds) on
                // top of "every cell < 1.0"; MC − M1 on the same seeds is
                // reported only (it replaced the relative bound "M1 + 0.005").
                let ceiling = suite::CRITERION_MC_CEILING;
                let ok = worst <= ceiling;
                println!(
                    "MC best-response ceiling (CQH2): worst cell {worst:.6} ≤ {ceiling}: {}",
                    if ok { "PASS" } else { "FAIL" }
                );
                fail |= !ok;
                let mut m1 = cfg.clone();
                m1.cq = Config::default().cq;
                m1.bannerdom = 0;
                m1.keepdom = false;
                m1.forward = false;
                m1.keep_stay = false;
                m1.policy = [mc::Policy::Lone; 6];
                m1.bot_profile = Config::default().bot_profile;
                m1.set_rules(mc::Rules::M1, None);
                let r1 = suite::criterion_best(
                    &m1,
                    seeds,
                    first_seed.unwrap_or(suite::CRITERION_FIRST_SEED),
                    &[false, true],
                );
                let (_, w1) = suite::criterion_best_table(&r1);
                println!(
                    "M1 control on the same seeds (reported): worst cell {w1:.6}; MC − M1 = {:+.6} (report only, CQH2)",
                    worst - w1
                );
            }
            if gate && fail {
                std::process::exit(1);
            }
        }
        "criterion" => {
            let rows = suite::criterion_rows(
                &cfg,
                seeds,
                first_seed.unwrap_or(suite::CRITERION_FIRST_SEED),
                &[("this config".to_string(), cfg.clone())],
                &[false, true],
            );
            println!("{}", suite::criterion_table(&rows));
        }
        "c4" => {
            let spec = c4::Spec {
                agents: cfg.agents,
                seeds,
                first_seed: first_seed.unwrap_or(0),
            };
            let (md, js) = c4::run(&cfg, &spec);
            match out {
                Some(p) => {
                    std::fs::write(&p, &md).expect("write results");
                    std::fs::write(format!("{p}.json"), &js).expect("write json");
                    eprintln!("wrote {p} and {p}.json");
                }
                None => println!("{md}\n{js}"),
            }
        }
        "conquest" => {
            // --cq-set "label:k=v,k=v;label2:..." (each on top of --cq)
            let set = std::env::var("CQ_SET").unwrap_or_else(|_| "base:".into());
            let mut cfgs = Vec::new();
            for part in set.split(';').filter(|x| !x.is_empty()) {
                let (label, spec) = part.split_once(':').unwrap_or((part, ""));
                let mut c = cfg.clone();
                c.cq.apply(spec);
                cfgs.push((label.to_string(), c));
            }
            let t = std::time::Instant::now();
            let rows = conquest::sweep(&cfgs, seeds, first_seed.unwrap_or(0));
            println!(
                "agents {}, days {}, seeds {} (first {}), {:.0} s\n",
                cfg.agents,
                cfg.days,
                seeds,
                first_seed.unwrap_or(0) + 1,
                t.elapsed().as_secs_f64()
            );
            if std::env::var("CQ_SHORT").is_ok() {
                println!("{}", conquest::table_short(&rows));
            } else {
                println!("{}", conquest::table(&rows));
            }
        }
        "curve" => {
            let (sim, _) = suite::play(&cfg);
            println!("{}", conquest::curve(&sim.cq));
            println!("diag {:?}", sim.cq.diag);
            let mut kinds = [[0u32; 3]; 2];
            for x in &sim.holds {
                if !x.alive {
                    continue;
                }
                let k = if x.owner == u32::MAX {
                    0
                } else if x.h.order <= 1 {
                    1
                } else {
                    2
                };
                let hl = permutation_rules::frontier::geometry::is_heartland(
                    sim.prov(x.prov).coord,
                    x.faction,
                );
                kinds[hl as usize][k] += 1;
            }
            println!(
                "alive holdings [non-heartland, heartland] x [FC, first, other]: {:?}",
                kinds
            );
            if let Ok(p) = std::env::var("CQ_SERIES") {
                let mut out = String::new();
                for (d, v) in sim.cq.series.iter().enumerate() {
                    let row: Vec<String> = v
                        .iter()
                        .map(|&c| {
                            if c == u32::MAX {
                                "-".into()
                            } else {
                                c.to_string()
                            }
                        })
                        .collect();
                    out.push_str(&format!("{d},{}\n", row.join(",")));
                }
                std::fs::write(p, out).expect("series");
            }
        }
        "mapmove" => {
            let fs = first_seed.unwrap_or(0);
            let t = std::time::Instant::now();
            let ms = mapmove::run(&cfg, seeds, fs);
            let gate = if gate28 {
                mapmove::floors_28d()
            } else {
                mapmove::floors_c10(cfg.days)
            };
            let d = mapmove::describe(&cfg, seeds, fs);
            println!(
                "mapmove: {} ({:.0} s)\n",
                d.iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join(" "),
                t.elapsed().as_secs_f64()
            );
            println!("{}", mapmove::table(&ms, &gate));
            println!("{}", mapmove::reported_table(&ms));
            let mut fail = false;
            if let Some(x) = leader_max {
                let ok = ms.iter().filter(|m| m.f0_share_end <= x).count();
                let need = (ms.len() * 8).div_ceil(10);
                // The same check serves OD-16 (one campaign faction among
                // lone ones) and the size stress (PO-4, CQH1(4): faction 0
                // two or three times the others' size).
                let w = cfg.faction_weights;
                let what = if w.iter().all(|&x| x == w[0]) {
                    "coordination check (OD-16)".to_string()
                } else {
                    format!(
                        "size stress check (PO-4, sizes {})",
                        w.map(|x| x.to_string()).join(",")
                    )
                };
                println!(
                    "{what}: faction 0 ends ≤ {x} of controlled provinces on {ok}/{} seeds (need {need}): {}",
                    ms.len(),
                    if ok >= need { "PASS" } else { "FAIL" }
                );
                fail |= ok < need;
            }
            if let Some(p) = &json {
                let note = mapmove::cadence_note(&cfg);
                std::fs::write(p, mapmove::to_json(&cfg, seeds, fs, &ms, &gate, note))
                    .expect("write json");
                eprintln!("wrote {p}");
            }
            if let Some(p) = &check {
                let text = std::fs::read_to_string(p).expect("read --check file");
                let bad = mapmove::check(&text, &cfg, seeds, fs, &ms, &gate);
                if bad.is_empty() {
                    println!("check {p}: no drift");
                } else {
                    println!("check {p}: DRIFT\n{}", bad.join("\n"));
                    fail = true;
                }
            }
            if fail {
                std::process::exit(1);
            }
        }
        "mapmove-gate" => {
            let fs = first_seed.unwrap_or(0);
            let mut gate = if gate28 || cfg.days > 7 {
                mapmove::floors_28d()
            } else {
                mapmove::floors_c10(cfg.days)
            };
            if let Some(p) = &thresholds {
                let text = std::fs::read_to_string(p).expect("read --thresholds file");
                for g in gate.iter_mut() {
                    if let Some(f) = mapmove::json_num(&text, &["gated", g.name, "floor"]) {
                        g.floor = f;
                    }
                }
                for g in &gate {
                    if let Some(h) = mapmove::json_num(&text, &["gated", g.name, "half_p10"]) {
                        println!(
                            "{}: floor {} (gated), ½ × p10 {} (reported)",
                            g.name, g.floor, h
                        );
                    }
                }
            }
            let ms = mapmove::run(&cfg, seeds, fs);
            println!("{}", mapmove::table(&ms, &gate));
            let (ok, text) = mapmove::gate_verdict(&ms, &gate);
            println!(
                "rules {}: {}\n{text}",
                cfg.rules.name(),
                if ok { "PASS" } else { "FAIL" }
            );
            let mut fail = !ok;
            if controls {
                for (name, r, pol) in [
                    ("--rules m1 --policy lone", mc::Rules::M1, mc::Policy::Lone),
                    (
                        "--rules mc-weightmap --policy campaign",
                        mc::Rules::McWeightmap,
                        mc::Policy::Campaign,
                    ),
                ] {
                    let mut c = cfg.clone();
                    c.cq = Config::default().cq;
                    c.bannerdom = 0;
                    c.keepdom = false;
                    c.forward = false;
                    c.keep_stay = false;
                    c.policy = [pol; 6];
                    c.set_rules(r, None);
                    let ms = mapmove::run(&c, seeds, fs);
                    let (cok, text) = mapmove::gate_verdict(&ms, &gate);
                    println!(
                        "### control {name}\n\n{}\n{text}",
                        mapmove::table(&ms, &gate)
                    );
                    if cok {
                        println!("control {name} PASSED the gate: the gate has lost its power");
                        fail = true;
                    } else {
                        println!("control {name} FAILS as it must\n");
                    }
                }
            }
            if fail {
                std::process::exit(1);
            }
        }
        other => panic!("unknown command {other}"),
    }
}
