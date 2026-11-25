//! Temporary NATURAL local-play node (launcher preset `local-natural-v1`; see `itest::natural_play`): a new Season by
//! its own instructions, the player's real Join and PlaceHome from the page, then the keeper on that home. Prints
//! public JSON lines, serves on 127.0.0.1 until Ctrl-C, then stops. No key of the player's, no tamper RPC; the only
//! sends are the world's own setup and the keeper's. No persistence unless `--persist-dir` is given (TEST-ONLY,
//! `itest::natural_persist`: a private run dir, resumed when it already holds a world).
//!
//!   localnet-natural-play --artifact <abs .so> --artifact-sha256 <hex> --player-wallet <base58 public key> \
//!     --rpc-port <41000-41999> --ws-port <41000-41999> --keeper public-quicknet \
//!     [--continuous local-continuous-v1] [--persist-dir <abs private dir>] [--map-origin <unix seconds>]
//!
//! `--map-origin` (TEST-ONLY, `itest::natural_persist`): a NEW world's chain clock origin, in the 365 days before the
//! fixed one. Without it every world consumes the same genesis round and so has the same map; with it the Season
//! fixes another round and the program derives another genesis seed by its unchanged rules. The first line then says
//! `fresh_map: {mode, origin, genesis_round}`.
use itest::expedition_play as play;
use itest::natural_play as natural;

fn main() {
    let result = (|| -> Result<(), String> {
        // the TEST-ONLY capture demo's two options are taken out first (both or neither; the shared parser never sees them)
        // the TEST-ONLY continuous preset and run dir (natural_persist) first: never with the demo's compressed clock
        let (rest, world_opts) =
            itest::natural_persist::take_world_args(std::env::args().skip(1).collect())?;
        // (the TEST-ONLY wide land: a memory-only natural world of its own, on the natural clock after its setup)
        let (rest, wide) = itest::wide_land::take_wide_args(rest)?;
        // (its TEST-ONLY clock scale from ready-for-join on: only with the wide land)
        let (rest, wide_scale) = itest::wide_land::take_wide_scale(rest)?;
        if wide_scale.is_some() && !wide {
            return Err("--wide-scale is accepted only together with --wide-land".into());
        }
        let mut world_opts = world_opts;
        world_opts.wide = wide;
        let (rest, demo) = itest::capture_demo::take_demo_args(rest)?;
        if wide && demo.is_some() {
            return Err("--wide-land is not accepted with --capture-demo".into());
        }
        if demo.is_some() && (world_opts.continuous || world_opts.persist.is_some()) {
            return Err(
                "--continuous and --persist-dir are not accepted with --capture-demo".into(),
            );
        }
        // the TEST-ONLY contest pair's two options likewise (both or neither): two people in one world, on a capture-demo
        // world or (B16, loop-play3) a natural one, kept (--continuous/--persist-dir) or not
        let (rest, second) = itest::contest_pair::take_pair_args(rest)?;
        if second.is_some() && wide {
            return Err("--contest-pair is not accepted with --wide-land".into());
        }
        // the TEST-ONLY land lane's option likewise (only with the capture demo's synthetic clock; feature localnet-land-play)
        #[cfg(feature = "localnet-land-play")]
        let (rest, land) = itest::land_lane::take_land_args(rest)?;
        #[cfg(not(feature = "localnet-land-play"))]
        let land = false;
        if land && demo.is_none() {
            return Err("--land-preview is accepted only together with --capture-demo".into());
        }
        // the TEST-ONLY operator AI war world's option likewise: on any natural world (loop-play4 B-6: the kept, plain,
        // fresh-map and wide worlds too, so that the AI residents' marches are revealed and settled by the keeper loop
        // that serves their villages, as the player's are). Only the demo also opens the rest of its new ring (open_rest)
        let (rest, operators) = itest::operator_villages::take_villages_args(rest)?;
        // (TEST-ONLY external residents, runner-throughput-2: their villages join the same keeper loop as the operator
        //  residents' — the launcher passes it for a natural world that admitted external residents)
        // (external-wide: also on a wide world, as `--operator-villages` is — a rim first village settled from a
        //  FileTicket is read from the Citizen's slot 1 like a PlaceHome one; operator_villages::home_of)
        let (rest, externals) = itest::operator_villages::take_external_args(rest)?;
        if externals.is_some() && second.is_some() {
            return Err("--external-villages is not accepted with --contest-pair".into());
        }
        if wide {
            // (TEST-ONLY wide world: rim villages march into the wide land by the expedition wrapper; this runner reveals
            //  them from the public round and catches the wide destination up from its opening turn)
            itest::destination_driver::enable_wide_expeditions();
        }
        let o = play::parse_args(rest)?;
        if second == Some(o.player_wallet) {
            return Err("--second-wallet must be another wallet than --player-wallet".into());
        }
        if !o.keeper {
            return Err("the natural world needs --keeper public-quicknet (its turns are resolved by the keeper)".into());
        }
        if o.wide_destination {
            return Err("the natural world has no wide-destination fixture".into());
        }
        let artifact = play::read_artifact(&o)?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(async {
            let mut world = natural::prepare_with(&artifact, o.player_wallet, o.rpc_port, o.ws_port, &world_opts).await?;
            // (the TEST-ONLY capture demo is stated in the world's own first line, which the launcher checks against its options)
            if let Some(scale) = demo {
                itest::capture_demo::demo_metadata(&mut world.metadata, scale);
            }
            // (the second player of the TEST-ONLY pair: funded like the first, fees and rent only — once: a resumed kept
            //  world funded it at its first start, and nothing is funded at a resume)
            if let Some(b) = second {
                if !world.resumed {
                    let mut c = localnet::server::lock(&world.state);
                    c.airdrop(&b, play::PLAYER_LAMPORTS)?;
                    c.produce_block();
                }
                itest::contest_pair::pair_metadata(&mut world.metadata, &b);
            }
            #[cfg(feature = "localnet-land-play")]
            if land {
                itest::land_lane::land_metadata(&mut world.metadata);
            }
            if let Some(scale) = wide_scale {
                world.metadata["wide_land"]["scale"] = serde_json::json!(scale);
                world.metadata["clock"] = serde_json::json!(format!("SYNTHETIC before genesis and through the wide land's growth; from ready-for-join on a TEST clock at x{scale} (TEST-ONLY --wide-scale)"));
                // (applied with the first natural block: the chain is still paused here)
                localnet::server::lock(&world.state).set_scale(scale as f64);
            }
            println!("{}", world.metadata);
            let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
            let keeper_rx = stop_rx.clone();
            let mut hold_rx = stop_rx.clone();
            let state = world.state.clone();
            let wallet = o.player_wallet;
            #[cfg(feature = "localnet-land-play")]
            if land {
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                tokio::spawn(async move {
                    if let Err(e) = itest::land_lane::run(st, a, rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::land_lane::LAND_SCHEMA, "land_step": "stopped", "test_only": true, "why": e}));
                    }
                });
            }
            // (TEST-ONLY wide play: the wide claims' class-D duty, beside the keeper)
            if wide {
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                tokio::spawn(async move {
                    if let Err(e) = itest::wide_play::run_claims(st, a, rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::wide_play::WIDE_PLAY_SCHEMA, "wide_play_step": "stopped", "test_only": true, "why": e}));
                    }
                });
            }
            // (TEST-ONLY map growth where nations go, expansion-gameplay-1: wide land opened next to villages and won
            //  keeps; the claim's reach witness lets a nation found there)
            if wide {
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                tokio::spawn(async move {
                    if let Err(e) = itest::wide_frontier::run(st, a, rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::wide_frontier::FRONTIER_SCHEMA, "wide_frontier_step": "stopped", "test_only": true, "why": e}));
                    }
                });
            }
            // (TEST-ONLY player territory, territory-impl owner 2026-11-24 12:09: the class-D crank of upkeep, decay
            //  and conquest transfers — the devnet keeper's role; play-local runs no keeper crate)
            if wide {
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                tokio::spawn(async move {
                    if let Err(e) = itest::wide_territory::run(st, a, rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::wide_territory::TERRITORY_SCHEMA, "wide_territory_step": "stopped", "test_only": true, "why": e}));
                    }
                });
            }
            // (TEST-ONLY research, world goal ②: the class-D crank of settles and applies — the devnet keeper's role to be)
            if wide {
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                tokio::spawn(async move {
                    if let Err(e) = itest::wide_research::run(st, a, rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::wide_research::RESEARCH_SCHEMA, "wide_research_step": "stopped", "test_only": true, "why": e}));
                    }
                });
            }
            // (TEST-ONLY wide -> wide marches, Q-W2 owner t385u: the wide bells and marches' class-D crank; the local
            //  land .so's `localnet-wide-depart` gate decides whether a WideDepart can land at all)
            if wide {
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                tokio::spawn(async move {
                    if let Err(e) = itest::wide_depart::run(st, a, rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::wide_depart::WIDE_DEPART_SCHEMA, "wide_depart_step": "stopped", "test_only": true, "why": e}));
                    }
                });
            }
            // (TEST-ONLY wide world, fix wide-herald-lag: the world's turns kept current from ready-for-join until the
            //  player's home lands — the keeper loop starts only there; this duty ends first, so the two never race)
            let mut warm = if wide {
                let (until_tx, until_rx) = tokio::sync::watch::channel(false);
                let (st, a, rx) = (world.state.clone(), world.a.clone(), stop_rx.clone());
                let h = tokio::spawn(async move {
                    if let Err(e) = itest::wide_land::warm_keep(st, a, rx, until_rx, |v| println!("{v}")).await {
                        println!("{}", serde_json::json!({"schema": itest::wide_land::WIDE_SCHEMA, "wide_step": "warm_keeper_stopped", "test_only": true, "why": e}));
                    }
                });
                Some((until_tx, h))
            } else {
                None
            };
            let task = tokio::spawn(async move {
                let world = std::sync::Arc::new(world);
                // (the second player's village joins the same keeper loop once its own PlaceHome lands)
                let (more_tx, more_rx) = tokio::sync::mpsc::unbounded_channel::<itest::keeper_loop::MoreVillage>();
                let pair_slot: itest::capture_demo::PairSlot = std::sync::Arc::new(std::sync::Mutex::new(None));
                // (TEST-ONLY operator AI war world: each operator resident's village joins the same keeper loop once its
                //  own PlaceHome lands, as the pair's second does; the demo's `ready` then opens the rest of its new ring)
                let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
                if let Some(path) = operators.clone() {
                    let (st, a, rx, tx) = (world.state.clone(), world.a.clone(), stop_rx.clone(), more_tx.clone());
                    tokio::spawn(async move { itest::operator_villages::watch(st, a, path, tx, rx, |v| println!("{v}")).await });
                    let (st, a, rx, ready) = (world.state.clone(), world.a.clone(), stop_rx.clone(), ready_rx.clone());
                    // (the demo's ring opening only: the wide world has no demo `ready` and opened its land in the setup)
                    if demo.is_some() { tokio::spawn(async move {
                        if let Err(e) = itest::operator_villages::open_rest(st, a, ready, rx, |v| println!("{v}")).await {
                            println!("{}", serde_json::json!({"schema": itest::operator_villages::VILLAGES_SCHEMA, "operator_step": "stopped", "test_only": true, "why": e}));
                        }
                    }); }
                }
                if let Some(path) = externals.clone() {
                    let (st, a, rx, tx) = (world.state.clone(), world.a.clone(), stop_rx.clone(), more_tx.clone());
                    tokio::spawn(async move { itest::operator_villages::watch_externals(st, a, path, tx, rx, |v| println!("{v}")).await });
                }
                if let Some(b) = second {
                    let (w2, mut rx2, slot2) = (world.clone(), stop_rx.clone(), pair_slot.clone());
                    tokio::spawn(async move {
                        match natural::await_home(&w2, &b, &mut rx2).await {
                            Ok((home, sig)) => {
                                println!("{}", itest::contest_pair::line("home", serde_json::json!({"p": home.home.0, "q": home.home.1, "site": home.site, "signature": sig})));
                                let _ = more_tx.send((itest::keeper_loop::public_quicknet(), home.holding, home.home));
                                // (both routes checked again on the chain's records once the demo has chosen the fort)
                                loop {
                                    if *rx2.borrow() { break; }
                                    let target = slot2.lock().unwrap().clone();
                                    if let Some(t) = target {
                                        match itest::capture_demo::verify_pair(&w2.state, &w2.a, &b, &t) {
                                            Ok(v) => println!("{}", itest::contest_pair::line("pair_ready", v)),
                                            Err(e) => println!("{}", itest::contest_pair::line("pair_not_ready", serde_json::json!({"why": e}))),
                                        }
                                        break;
                                    }
                                    tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}, _ = rx2.changed() => {} }
                                }
                            }
                            Err(e) => println!("{}", itest::contest_pair::line("stopped", serde_json::json!({"why": e}))),
                        }
                    });
                } else if operators.is_none() && externals.is_none() {
                    drop(more_tx);
                }
                let found = natural::await_home(&world, &wallet, &mut stop_rx).await;
                if let Some((until_tx, h)) = warm.take() {
                    let _ = until_tx.send(true);
                    let _ = h.await;
                }
                match found {
                    Ok((home, _sig)) => {
                        if let Some(scale) = demo {
                            let (st, a, homes, h, rx, player) = (state.clone(), world.a.clone(), world.homes.clone(), home.home, keeper_rx.clone(), wallet);
                            let pair = second.map(|b| (b, pair_slot.clone()));
                            tokio::spawn(async move {
                                if let Err(e) = itest::capture_demo::run(st, a, homes, h, player, pair, scale, rx, |v| { if v["demo_step"] == "ready" { let _ = ready_tx.send(true); } println!("{v}") }).await {
                                    println!("{}", serde_json::json!({"schema": itest::capture_demo::DEMO_SCHEMA, "demo_step": "stopped", "test_only": true, "why": e}));
                                }
                            });
                        }
                        // (the TEST-ONLY demo's pace: short ticks only while work lands; a natural world ticks as always)
                        let pace = if demo.is_some() { itest::keeper_loop::DEMO_PACE } else if wide_scale.is_some_and(|s| s > 1) { itest::keeper_loop::WIDE_PACE } else { itest::keeper_loop::Pace::Natural };
                        let more = if second.is_some() || operators.is_some() || externals.is_some() { Some(more_rx) } else { None };
                        itest::keeper_loop::run_paced_with(state, itest::keeper_loop::public_quicknet(), Some(home.holding), home.home, pace, keeper_rx, |s| println!("{}", s.json()), more).await;
                    }
                    Err(e) => println!("{}", serde_json::json!({"schema": natural::NATURAL_SCHEMA, "natural_step": "stopped", "why": e, "keeper_started": false})),
                }
                // the node keeps serving until the launcher ends the world, whatever the keeper did
                while !*hold_rx.borrow() {
                    if hold_rx.changed().await.is_err() {
                        break;
                    }
                }
                drop(world);
            });
            tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
            let _ = stop_tx.send(true);
            let _ = task.await;
            Ok(())
        })
    })();
    if let Err(e) = result {
        eprintln!("localnet-natural-play: {e}");
        std::process::exit(2);
    }
}
