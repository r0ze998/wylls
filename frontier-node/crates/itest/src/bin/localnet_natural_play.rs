//! Temporary NATURAL local-play node (launcher preset `local-natural-v1`; see `itest::natural_play`): a new Season by
//! its own instructions, the player's real Join and PlaceHome from the page, then the keeper on that home. Prints
//! public JSON lines, serves on 127.0.0.1 until Ctrl-C, then stops. No key of the player's, no persistence, no tamper
//! RPC; the only sends are the world's own setup and the keeper's.
//!
//!   localnet-natural-play --artifact <abs .so> --artifact-sha256 <hex> --player-wallet <base58 public key> \
//!     --rpc-port <41000-41999> --ws-port <41000-41999> --keeper public-quicknet
use itest::expedition_play as play;
use itest::natural_play as natural;

fn main() {
    let result = (|| -> Result<(), String> {
        // the TEST-ONLY capture demo's two options are taken out first (both or neither; the shared parser never sees them)
        let (rest, demo) = itest::capture_demo::take_demo_args(std::env::args().skip(1).collect())?;
        // the TEST-ONLY contest pair's two options likewise (both or neither), and only on a capture-demo world
        let (rest, second) = itest::contest_pair::take_pair_args(rest)?;
        if second.is_some() && demo.is_none() {
            return Err("--contest-pair is accepted only together with --capture-demo".into());
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
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
        rt.block_on(async {
            let mut world = natural::prepare(&artifact, o.player_wallet, o.rpc_port, o.ws_port).await?;
            // (the TEST-ONLY capture demo is stated in the world's own first line, which the launcher checks against its options)
            if let Some(scale) = demo {
                itest::capture_demo::demo_metadata(&mut world.metadata, scale);
            }
            // (the second player of the TEST-ONLY pair: funded like the first, fees and rent only)
            if let Some(b) = second {
                let mut c = localnet::server::lock(&world.state);
                c.airdrop(&b, play::PLAYER_LAMPORTS)?;
                c.produce_block();
                drop(c);
                itest::contest_pair::pair_metadata(&mut world.metadata, &b);
            }
            println!("{}", world.metadata);
            let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
            let keeper_rx = stop_rx.clone();
            let mut hold_rx = stop_rx.clone();
            let state = world.state.clone();
            let wallet = o.player_wallet;
            let task = tokio::spawn(async move {
                let world = std::sync::Arc::new(world);
                // (the second player's village joins the same keeper loop once its own PlaceHome lands)
                let (more_tx, more_rx) = tokio::sync::mpsc::unbounded_channel::<itest::keeper_loop::MoreVillage>();
                let pair_slot: itest::capture_demo::PairSlot = std::sync::Arc::new(std::sync::Mutex::new(None));
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
                } else {
                    drop(more_tx);
                }
                match natural::await_home(&world, &wallet, &mut stop_rx).await {
                    Ok((home, _sig)) => {
                        if let Some(scale) = demo {
                            let (st, a, homes, h, rx, player) = (state.clone(), world.a.clone(), world.homes.clone(), home.home, keeper_rx.clone(), wallet);
                            let pair = second.map(|b| (b, pair_slot.clone()));
                            tokio::spawn(async move {
                                if let Err(e) = itest::capture_demo::run(st, a, homes, h, player, pair, scale, rx, |v| println!("{v}")).await {
                                    println!("{}", serde_json::json!({"schema": itest::capture_demo::DEMO_SCHEMA, "demo_step": "stopped", "test_only": true, "why": e}));
                                }
                            });
                        }
                        // (the TEST-ONLY demo's pace: short ticks only while work lands; a natural world ticks as always)
                        let pace = if demo.is_some() { itest::keeper_loop::DEMO_PACE } else { itest::keeper_loop::Pace::Natural };
                        let more = if second.is_some() { Some(more_rx) } else { None };
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
